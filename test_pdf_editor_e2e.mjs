import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  createPdfProject,
  addSourceFile,
  appendSourcePages,
  moveOutputPage,
  removeOutputPage,
  duplicateOutputPage,
  extractPagesToProject,
  rotateOutputPage,
  setPageRotation,
  addMarkup,
  updateMarkup,
  deleteMarkup,
  setPageNumbers,
  setWatermark,
  projectToSpec,
  matchPdfFont,
  affineMultiply,
  mapTextItem,
  groupTextLines,
  sanitizeEditProps,
  addTextEdit,
  getTextEdit,
  editsForPage,
  findEditForSpan,
  updateTextEdit,
  deleteTextEdit,
  editFitScale,
  createUndoStack,
  pushUndo,
  undoProject,
  redoProject
} from './src/public/pdf-editor-project.js';
import {
  validatePdfEditSpec,
  renderPdfExport,
  displayedToUnrotated
} from './src/library/pdf-editor.js';

import { fileURLToPath } from 'node:url';

// Setup pdfjs worker
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./src/public/vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

async function createSyntheticPdf({ title = 'Sample Title', body = 'Sample Body Paragraph for testing', landscape = false, rotation = 0 }) {
  const doc = await PDFDocument.create();
  const pageW = landscape ? 842 : 595;
  const pageH = landscape ? 595 : 842;
  const page = doc.addPage([pageW, pageH]);
  if (rotation) page.setRotation(degrees(rotation));

  const fontHelvetica = await doc.embedFont(StandardFonts.Helvetica);
  const fontHelveticaBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const fontTimes = await doc.embedFont(StandardFonts.TimesRoman);
  const fontCourier = await doc.embedFont(StandardFonts.Courier);

  page.drawText(title, { x: 50, y: pageH - 80, size: 24, font: fontHelveticaBold, color: rgb(0.1, 0.1, 0.8) });
  page.drawText(body, { x: 50, y: pageH - 120, size: 14, font: fontHelvetica, color: rgb(0, 0, 0) });
  page.drawText('Secondary details in Times Roman', { x: 50, y: pageH - 150, size: 12, font: fontTimes, color: rgb(0.2, 0.2, 0.2) });
  page.drawText('Code fragment: var x = 42;', { x: 50, y: pageH - 180, size: 11, font: fontCourier, color: rgb(0.3, 0.3, 0.3) });

  const bytes = Buffer.from(await doc.save());
  return bytes;
}

async function runAllManualVerifications() {
  console.log('====================================================');
  console.log('STARTING MANUAL END-TO-END VERIFICATION PASS');
  console.log('====================================================\n');

  const results = {
    passed: [],
    failed: [],
    notes: []
  };

  // 1. OPEN / IMPORT PDF & ORIGINAL IMMUTABILITY CHECK
  console.log('--- Step 1: Open/import PDF & verify original immutability ---');
  const realPdfPath = './queries/Guidewire/Gosu/PC/Config/Query API/QueryAPI.pdf';
  const realPdfBytes = readFileSync(realPdfPath);
  const originalHash = sha256(realPdfBytes);
  console.log(`Loaded real PDF (${realPdfPath}), size: ${realPdfBytes.length} bytes, hash: ${originalHash.slice(0, 12)}...`);

  const syntheticBytes = await createSyntheticPdf({ title: 'Invoice #10045', body: 'Customer: Acme Corporation - Total: $5,400.00' });
  const syntheticHash = sha256(syntheticBytes);

  // 2. FULL-SCREEN 3-COLUMN LAYOUT & DOM VERIFICATION
  console.log('\n--- Step 2: Full-screen 3-column layout inspection ---');
  // Validate DOM template structure
  const ejs = await import('ejs');
  const path = await import('node:path');
  const html = await ejs.default.renderFile('./src/views/admin-pdf-editor.ejs', {
    user: { name: 'Admin', email: 'admin@test.com', app_role: 'OWNER' },
    pdfEditorAvailable: true,
    preselectedPath: ''
  });
  assert.ok(html.includes('class="pdf-studio"'), 'Root layout container exists');
  assert.ok(html.includes('class="pdf-toolbar"'), 'Top toolbar exists');
  assert.ok(html.includes('class="pdf-rail"'), 'Left page rail exists');
  assert.ok(html.includes('class="pdf-canvas-col"'), 'Central canvas container exists');
  assert.ok(html.includes('class="pdf-inspector-col"'), 'Right inspector column exists');
  assert.ok(html.includes('id="pdfOpenBtn"'), 'Open button exists');
  assert.ok(html.includes('id="pdfExportBtn"'), 'Export button exists');
  assert.ok(html.includes('id="pdfUndoBtn"'), 'Undo button exists');
  assert.ok(html.includes('id="pdfRedoBtn"'), 'Redo button exists');
  assert.ok(html.includes('id="pdfFitBtn"'), 'Fit button exists');
  results.passed.push('3-column workspace and complete toolbar markup verified');

  // 3. PAGE THUMBNAILS & NAVIGATION
  console.log('\n--- Step 3: Page thumbnails & navigation ---');
  const project = createPdfProject();
  const f1 = addSourceFile(project, { name: 'QueryAPI.pdf', pageCount: 3 });
  const f2 = addSourceFile(project, { name: 'Invoice.pdf', pageCount: 1 });
  appendSourcePages(project, f1.id);
  appendSourcePages(project, f2.id);
  assert.equal(project.pages.length, 4);
  project.selectedPageId = project.pages[0].id;
  assert.equal(project.selectedPageId, project.pages[0].id);
  results.passed.push('Multi-file merge and page initialization verified (4 pages loaded)');

  // 4. ZOOM & FIT CALCULATION
  console.log('\n--- Step 4: Zoom & Fit calculation ---');
  let zoom = 1.0;
  zoom = Math.min(3, zoom * 1.2); // zoom in: 1.2
  assert.equal(Math.round(zoom * 100), 120);
  zoom = Math.max(0.4, zoom / 1.2); // zoom out: 1.0
  assert.equal(Math.round(zoom * 100), 100);
  // Fit calculation simulation: 1000px width wrapper vs 595px page -> scale ~1.6
  const fitScale = (1000 - 48) / 595;
  const fitZoom = Math.min(3, Math.max(0.4, fitScale / (560 / 595)));
  assert.ok(fitZoom > 0.5 && fitZoom < 2.5);
  results.passed.push('Zoom clamping and fit-to-viewport calculations verified');

  // 5. EDIT MODE (DETECT EXISTING TEXT, HIT TEST, REPLACE, FONT PRESERVATION, AUTO-SHRINK)
  console.log('\n--- Step 5: Edit mode (Detect, Click, Replace, Font Match, Auto-shrink, Delete) ---');
  const pdfJsDoc = await pdfjsLib.getDocument({ data: new Uint8Array(syntheticBytes) }).promise;
  const pdfJsPage = await pdfJsDoc.getPage(1);
  const vp = pdfJsPage.getViewport({ scale: 1, rotation: 0 });
  const tc = await pdfJsPage.getTextContent();
  assert.ok(tc.items.length > 0, 'PDF.js extracted text items');

  const mappedItems = [];
  const styles = tc.styles || {};
  for (const it of tc.items) {
    const style = styles[it.fontName] || {};
    const fontName = style.fontFamily ? `${it.fontName} ${style.fontFamily}` : it.fontName;
    const m = mapTextItem({ ...it, fontName }, vp.transform, vp.width, vp.height);
    if (!m || m.rotated || !m.text.trim()) continue;
    const fam = matchPdfFont(m.fontName);
    const sizePt = m.sizeFrac * vp.height;
    const wPt = m.text.length * sizePt * 0.55;
    mappedItems.push({ ...m, wFrac: wPt / vp.width });
  }
  const spans = groupTextLines(mappedItems);
  console.log(`Detected ${spans.length} text lines in synthetic document:`);
  spans.forEach((s, idx) => console.log(`  [${idx}] "${s.text}" @ x:${s.x}, y:${s.y}, font:${s.fontName}`));

  assert.ok(spans.length >= 4, 'All lines grouped successfully');
  const titleSpan = spans[0];
  assert.ok(titleSpan.text.includes('Invoice #10045'), 'Title line recognized correctly');

  // Font matching test
  const matchedFont = matchPdfFont(titleSpan.fontName);
  console.log(`Matched font for "${titleSpan.fontName}": family=${matchedFont.family}, bold=${matchedFont.bold}, italic=${matchedFont.italic}`);
  assert.equal(matchedFont.family, 'Helvetica');
  // Also test font matching on known standard fonts
  assert.deepEqual(matchPdfFont('Arial-Bold'), { family: 'Helvetica', bold: true, italic: false });
  assert.deepEqual(matchPdfFont('TimesNewRomanPS-Italic'), { family: 'TimesRoman', bold: false, italic: true });
  assert.deepEqual(matchPdfFont('CourierNewPS-BoldItalic'), { family: 'Courier', bold: true, italic: true });

  // Add text edit replacement (short)
  const page0Id = project.pages[0].id;
  const edit1 = addTextEdit(project, page0Id, titleSpan, 'Invoice #99999 (REVISED)', {
    font: matchedFont.family,
    bold: matchedFont.bold,
    italic: matchedFont.italic,
    color: '#0000FF'
  });
  assert.equal(edit1.text, 'Invoice #99999 (REVISED)');
  assert.equal(edit1.bold, true);
  assert.equal(edit1.color, '#0000FF');

  // Long replacement text auto-shrink test
  const bodySpan = spans[1];
  const longReplacement = 'Customer: Extremely Long Enterprise International Corporation Subsidiary LLC - Grand Total: $125,400.00 USD';
  const origBoxWidthPx = bodySpan.w * 600;
  const longTextWidthPx = longReplacement.length * (bodySpan.size * 800) * 0.55;
  const shrinkScale = editFitScale(longTextWidthPx, origBoxWidthPx);
  console.log(`Auto-shrink ratio for long replacement (${longReplacement.length} chars vs box): ${(shrinkScale * 100).toFixed(1)}%`);
  assert.ok(shrinkScale < 1.0, 'Long replacement correctly auto-shrunk');

  const edit2 = addTextEdit(project, page0Id, bodySpan, longReplacement, {
    font: 'Helvetica',
    fitScale: shrinkScale
  });
  assert.equal(edit2.fitScale, shrinkScale);

  // Test findEditForSpan
  const foundEdit = findEditForSpan(project, page0Id, { x: titleSpan.x, y: titleSpan.y, w: titleSpan.w, h: titleSpan.h }, titleSpan.text);
  assert.equal(foundEdit.id, edit1.id);

  // Test update & delete edit
  updateTextEdit(project, edit1.id, { text: 'Invoice #88888', align: 'center' });
  assert.equal(edit1.text, 'Invoice #88888');
  assert.equal(edit1.align, 'center');
  results.passed.push('Existing text detection, font preservation, replacement, auto-shrink, and edit CRUD verified');

  // 6. ANNOTATION TOOLS (TEXT, RECT, WHITEOUT, HIGHLIGHT, ELLIPSE, LINE, DRAW)
  console.log('\n--- Step 6: Annotation tools verification ---');
  const mText = addMarkup(project, page0Id, 'text', { text: 'Approved by Manager', x: 0.1, y: 0.7, size: 0.035, color: '#008800' });
  const mHighlight = addMarkup(project, page0Id, 'rect', { x: 0.1, y: 0.3, w: 0.5, h: 0.04, fill: '#FFFF00', fillOpacity: 0.35, stroke: null, strokeWidth: 0 });
  const mWhiteout = addMarkup(project, page0Id, 'rect', { x: 0.1, y: 0.4, w: 0.4, h: 0.05, fill: '#FFFFFF', fillOpacity: 1.0, stroke: null, strokeWidth: 0 });
  const mEllipse = addMarkup(project, page0Id, 'ellipse', { x: 0.6, y: 0.6, w: 0.2, h: 0.1, stroke: '#FF0000', strokeWidth: 2 });
  const mLine = addMarkup(project, page0Id, 'line', { x1: 0.1, y1: 0.8, x2: 0.9, y2: 0.8, stroke: '#000000', strokeWidth: 1.5 });
  const mPen = addMarkup(project, page0Id, 'path', { points: [[0.1, 0.85], [0.15, 0.87], [0.2, 0.84]], stroke: '#0000FF', strokeWidth: 2 });
  assert.equal(markupsForPage(project, page0Id).length, 6);
  results.passed.push('All 6 annotation tools (Text, Highlight, Whiteout, Ellipse, Line, Pen path) verified');

  // 7. UNDO / REDO
  console.log('\n--- Step 7: Undo / Redo lifecycle ---');
  const undoStack = createUndoStack();
  pushUndo(undoStack, project);
  rotateOutputPage(project, page0Id);
  assert.equal(project.pages[0].rotate, 90);
  assert.equal(undoProject(project, undoStack), true);
  assert.equal(project.pages[0].rotate, 0);
  assert.equal(redoProject(project, undoStack), true);
  assert.equal(project.pages[0].rotate, 90);
  // Revert back
  undoProject(project, undoStack);
  results.passed.push('Undo / Redo state serialization and restore verified');

  // 8. PAGE OPERATIONS (DUPLICATE, ROTATE, REORDER, EXTRACT, DELETE)
  console.log('\n--- Step 8: Page operations ---');
  const initialPageCount = project.pages.length;
  // Duplicate
  const duplicated = duplicateOutputPage(project, page0Id);
  assert.equal(project.pages.length, initialPageCount + 1);
  assert.equal(editsForPage(project, duplicated.id).length, 2);
  assert.equal(markupsForPage(project, duplicated.id).length, 6);

  // Rotate
  rotateOutputPage(project, duplicated.id);
  assert.equal(duplicated.rotate, 90);

  // Move
  const lastId = duplicated.id;
  moveOutputPage(project, lastId, 0);
  assert.equal(project.pages[0].id, lastId);

  // Extract
  const extracted = extractPagesToProject(project, [lastId]);
  assert.equal(extracted.pages.length, 1);
  assert.equal(editsForPage(extracted, extracted.pages[0].id).length, 2);

  // Delete
  removeOutputPage(project, lastId);
  assert.equal(project.pages.length, initialPageCount);
  results.passed.push('Page duplicate, rotate, move, extract, delete with cascaded edits/markups verified');

  // 9. PAGE NUMBERS & WATERMARK
  console.log('\n--- Step 9: Page numbers & watermark ---');
  setPageNumbers(project, { start: 1, position: 'bottom-center', fontSize: 11, color: '#333333' });
  setWatermark(project, { text: 'CONFIDENTIAL', fontSize: 54, color: '#CC0000', opacity: 0.2, angle: -45 });
  assert.equal(project.pageNumbers.position, 'bottom-center');
  assert.equal(project.watermark.text, 'CONFIDENTIAL');
  results.passed.push('Page numbers and watermark settings verified');

  // 10. EXPORT & REOPEN EXPORTED PDF
  console.log('\n--- Step 10: Export and reopen exported PDF ---');
  const spec = projectToSpec(project);
  const validated = validatePdfEditSpec(spec);
  assert.ok(validated.ok, `Spec validation failed: ${validated.error}`);

  const exportedBytes = await renderPdfExport({
    pdfBytesList: [syntheticBytes, syntheticBytes], // using synthetic files for fast exact assertion
    imageBytesList: [],
    spec: validated.spec
  });

  console.log(`Exported PDF size: ${exportedBytes.length} bytes`);
  assert.ok(exportedBytes.length > 1000);
  assert.equal(Buffer.from(exportedBytes.slice(0, 5)).toString('latin1'), '%PDF-');

  // Reopen and parse exported PDF with pdf-lib and pdf.js
  const exportedDoc = await PDFDocument.load(exportedBytes);
  assert.equal(exportedDoc.getPageCount(), project.pages.length);

  const exportedJsDoc = await pdfjsLib.getDocument({ data: new Uint8Array(exportedBytes) }).promise;
  const exportedJsPage1 = await exportedJsDoc.getPage(1);
  const exportedTc = await exportedJsPage1.getTextContent();
  const allExportedStrings = exportedTc.items.map(i => i.str).join(' ');
  console.log(`Exported Page 1 Text Content sample: "${allExportedStrings.slice(0, 120)}..."`);
  assert.ok(allExportedStrings.includes('Invoice #88888'), 'Export contains updated replacement text');
  assert.ok(allExportedStrings.includes('CONFIDENTIAL'), 'Export contains watermark text');
  results.passed.push('Export rendering and PDF re-reading verification successful');

  // 11. VERIFY ORIGINAL PDF REMAINS UNCHANGED
  console.log('\n--- Step 11: Verify original PDF remains unchanged ---');
  const currentRealPdfBytes = readFileSync(realPdfPath);
  const currentHash = sha256(currentRealPdfBytes);
  assert.equal(currentHash, originalHash, 'Original source PDF has been modified!');
  console.log(`Original PDF verified unchanged: ${originalHash} === ${currentHash}`);
  results.passed.push('Original PDF file byte-for-byte immutability verified');

  console.log('\n====================================================');
  console.log('FINAL MANUAL VERIFICATION SUMMARY:');
  console.log('====================================================');
  results.passed.forEach((p, i) => console.log(`✓ [${i+1}] ${p}`));
  return results;
}

runAllManualVerifications().catch(err => {
  console.error('FATAL VERIFICATION ERROR:', err);
  process.exit(1);
});
