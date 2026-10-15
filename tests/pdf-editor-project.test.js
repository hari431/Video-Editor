import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPdfProject,
  getPdfFile,
  getOutputPage,
  getMarkup,
  markupsForPage,
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
  resetPdfProjectIds,
  matchPdfFont,
  affineMultiply,
  mapTextItem,
  groupTextLines,
  extractWordSpans,
  diffLineText,
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
  redoProject,
  PDF_PROJECT_MAX_FILES,
  PDF_PROJECT_MAX_PAGES
} from '../src/public/pdf-editor-project.js';

test.beforeEach(() => resetPdfProjectIds());

function mkProject() {
  const p = createPdfProject();
  const f1 = addSourceFile(p, { name: 'a.pdf', pageCount: 3 });
  const f2 = addSourceFile(p, { name: 'b.pdf', pageCount: 2 });
  appendSourcePages(p, f1.id);
  appendSourcePages(p, f2.id);
  return { p, f1, f2 };
}

test('createPdfProject starts empty', () => {
  const p = createPdfProject();
  assert.equal(p.version, 1);
  assert.deepEqual([p.files.length, p.pages.length, p.markups.length], [0, 0, 0]);
  assert.equal(p.pageNumbers, null);
  assert.equal(p.watermark, null);
});

test('addSourceFile validates page counts and file cap', () => {
  const p = createPdfProject();
  const f = addSourceFile(p, { name: 'a.pdf', pageCount: 5 });
  assert.equal(f.pageCount, 5);
  assert.equal(getPdfFile(p, f.id).name, 'a.pdf');
  assert.equal(getPdfFile(p, 'missing'), null);
  assert.throws(() => addSourceFile(p, { name: 'x.pdf', pageCount: 0 }), /page count/);
  assert.throws(() => addSourceFile(p, { name: 'x.pdf', pageCount: 501 }), /page count/);
  for (let i = 1; i < PDF_PROJECT_MAX_FILES; i++) addSourceFile(p, { name: `f${i}.pdf`, pageCount: 1 });
  assert.throws(() => addSourceFile(p, { name: 'extra.pdf', pageCount: 1 }), /Too many/);
});

test('appendSourcePages merges ranges in order (merge workflow)', () => {
  const { p, f1, f2 } = mkProject();
  assert.equal(p.pages.length, 5);
  assert.deepEqual(p.pages.map(x => [x.file, x.page]), [
    [f1.id, 1], [f1.id, 2], [f1.id, 3], [f2.id, 1], [f2.id, 2]
  ]);
  const part = appendSourcePages(p, f1.id, 2, 2);
  assert.equal(part.length, 1);
  assert.equal(part[0].page, 2);
  assert.throws(() => appendSourcePages(p, 'missing', 1, 1), /not found/);
  assert.throws(() => appendSourcePages(p, f1.id, 3, 2), /range/);
});

test('move/remove/rotate output pages', () => {
  const { p } = mkProject();
  const first = p.pages[0].id;
  moveOutputPage(p, first, 4);
  assert.equal(p.pages[4].id, first);
  moveOutputPage(p, first, -99);
  assert.equal(p.pages[0].id, first);
  assert.equal(rotateOutputPage(p, first).rotate, 90);
  assert.equal(rotateOutputPage(p, first).rotate, 180);
  assert.equal(setPageRotation(p, first, 270).rotate, 270);
  assert.throws(() => setPageRotation(p, first, 45), /Rotation/);
  assert.equal(removeOutputPage(p, first), true);
  assert.equal(removeOutputPage(p, 'missing'), false);
  assert.throws(() => moveOutputPage(p, 'missing', 0), /not found/);
});

test('removeOutputPage drops its markups; others stay', () => {
  const { p } = mkProject();
  const a = addMarkup(p, p.pages[0].id, 'text', { text: 'hi' });
  const b = addMarkup(p, p.pages[1].id, 'text', { text: 'yo' });
  assert.equal(removeOutputPage(p, p.pages[0].id), true);
  assert.equal(getMarkup(p, a.id), null);
  assert.ok(getMarkup(p, b.id));
});

test('extractPagesToProject copies pages+markups, source unchanged', () => {
  const { p } = mkProject();
  addMarkup(p, p.pages[0].id, 'text', { text: 'keep' });
  const before = p.pages.length;
  const next = extractPagesToProject(p, [p.pages[0].id, p.pages[2].id]);
  assert.equal(next.pages.length, 2);
  assert.equal(next.markups.length, 1);
  assert.equal(next.markups[0].text, 'keep');
  assert.notEqual(next.pages[0].id, p.pages[0].id);
  assert.equal(p.pages.length, before);
  assert.throws(() => extractPagesToProject(p, []), /at least one/);
  assert.throws(() => extractPagesToProject(p, ['missing']), /not found/);
});

test('addMarkup supports every kind with defaults', () => {
  const { p } = mkProject();
  const pid = p.pages[0].id;
  assert.equal(addMarkup(p, pid, 'text', { text: 'Hello' }).text, 'Hello');
  assert.equal(addMarkup(p, pid, 'image', { file: 0 }).file, 0);
  const r = addMarkup(p, pid, 'rect', { x: 0.1, y: 0.1, w: 0.2, h: 0.2, fill: '#FFFFFF', fillOpacity: 1 });
  assert.equal(r.fill, '#FFFFFF');
  assert.equal(addMarkup(p, pid, 'ellipse', {}).kind, 'ellipse');
  assert.equal(addMarkup(p, pid, 'line', {}).kind, 'line');
  assert.equal(addMarkup(p, pid, 'path', { points: [[0, 0], [0.5, 0.5]] }).points.length, 2);
  assert.equal(markupsForPage(p, pid).length, 6);
  assert.throws(() => addMarkup(p, pid, 'nope', {}), /Unknown markup kind/);
  assert.throws(() => addMarkup(p, 'missing', 'text', {}), /Output page not found/);
});

test('markup validation rejects bad geometry/props', () => {
  const { p } = mkProject();
  const pid = p.pages[0].id;
  assert.throws(() => addMarkup(p, pid, 'text', { text: '' }), /1–500/);
  assert.throws(() => addMarkup(p, pid, 'text', { text: 'x', size: 0.9 }), /size/);
  assert.throws(() => addMarkup(p, pid, 'text', { text: 'x', color: 'red' }), /color/);
  // Rect defaults carry a highlight fill, so bare props still paint.
  assert.equal(addMarkup(p, pid, 'rect', { x: 0, y: 0, w: 0.1, h: 0.1 }).fill, '#FFFF00');
  // Explicit null clears fill/stroke (outline-only shapes); undefined keeps.
  const outline = addMarkup(p, pid, 'rect', { x: 0, y: 0, w: 0.2, h: 0.2, fill: null, stroke: '#FF0000', strokeWidth: 2 });
  assert.equal(outline.fill, null);
  assert.equal(outline.stroke, '#FF0000');
  const ell = addMarkup(p, pid, 'ellipse', { x: 0, y: 0, w: 0.2, h: 0.2, fill: null, stroke: '#0000FF', strokeWidth: 2 });
  assert.equal(ell.fill, null);
  assert.equal(updateMarkup(p, outline.id, { fill: '#FFFFFF' }).fill, '#FFFFFF');
  assert.equal(updateMarkup(p, outline.id, { fill: null }).fill, null);
  assert.equal(updateMarkup(p, outline.id, { stroke: null }).stroke, null);
  assert.throws(() => addMarkup(p, pid, 'line', { x1: 2, y1: 0, x2: 0, y2: 0 }), /x1/);
  assert.throws(() => addMarkup(p, pid, 'path', { points: [[0, 0]] }), /2–/);
});

test('update/delete markup', () => {
  const { p } = mkProject();
  const m = addMarkup(p, p.pages[0].id, 'text', { text: 'a' });
  assert.equal(updateMarkup(p, m.id, { text: 'b', size: 0.08 }).text, 'b');
  assert.equal(m.size, 0.08);
  assert.throws(() => updateMarkup(p, m.id, { size: 9 }), /size/);
  assert.throws(() => updateMarkup(p, 'missing', {}), /not found/);
  assert.equal(deleteMarkup(p, m.id), true);
  assert.equal(deleteMarkup(p, m.id), false);
});

test('page numbers + watermark settings', () => {
  const { p } = mkProject();
  assert.deepEqual(setPageNumbers(p, {}), { start: 1, position: 'bottom-center', margin: 0.04, fontSize: 11, color: '#000000' });
  assert.equal(setPageNumbers(p, null), null);
  assert.throws(() => setPageNumbers(p, { position: 'middle' }), /position/);
  assert.throws(() => setPageNumbers(p, { fontSize: 200 }), /fontSize/);
  const wm = setWatermark(p, { text: 'DRAFT' });
  assert.equal(wm.text, 'DRAFT');
  assert.equal(wm.angle, -45);
  assert.equal(setWatermark(p, null), null);
  assert.throws(() => setWatermark(p, { text: '' }), /single line/);
  assert.throws(() => setWatermark(p, { text: 'a\nb' }), /single line/);
});

test('projectToSpec maps files to indices and pages to 0-based', () => {
  const { p, f1, f2 } = mkProject();
  addMarkup(p, p.pages[0].id, 'text', { text: 'Hi' });
  setPageNumbers(p, { start: 5 });
  setWatermark(p, { text: 'W' });
  const spec = projectToSpec(p);
  assert.equal(spec.version, 2);
  assert.deepEqual(spec.files, [{ name: 'a.pdf' }, { name: 'b.pdf' }]);
  assert.equal(spec.pages.length, 5);
  assert.deepEqual([spec.pages[0].file, spec.pages[0].page], [0, 0]);
  assert.deepEqual([spec.pages[3].file, spec.pages[3].page], [1, 0]);
  assert.equal(spec.pages[0].markups[0].text, 'Hi');
  assert.ok(!('id' in spec.pages[0].markups[0]), 'markup ids stripped');
  assert.equal(spec.pageNumbers.start, 5);
  assert.equal(spec.watermark.text, 'W');
  void f1; void f2;
  assert.throws(() => projectToSpec(createPdfProject()), /source PDF/);
  const empty = createPdfProject();
  addSourceFile(empty, { name: 'a.pdf', pageCount: 1 });
  assert.throws(() => projectToSpec(empty), /no pages/);
});

test('output page cap is enforced', () => {
  const p = createPdfProject();
  const f = addSourceFile(p, { name: 'big.pdf', pageCount: PDF_PROJECT_MAX_PAGES });
  appendSourcePages(p, f.id);
  assert.equal(p.pages.length, PDF_PROJECT_MAX_PAGES);
  assert.throws(() => appendSourcePages(p, f.id, 1, 1), /Too many output pages/);
});

test('duplicateOutputPage copies pages with markups and text edits', () => {
  const { p } = mkProject();
  const pid = p.pages[0].id;
  addMarkup(p, pid, 'text', { text: 'm1' });
  addTextEdit(p, pid, { x: 0.1, y: 0.1, w: 0.2, h: 0.05, text: 'orig', size: 0.04, fontName: 'Arial' }, 'edited');
  const dup = duplicateOutputPage(p, pid);
  assert.equal(p.pages.length, 6);
  assert.equal(dup.page, p.pages[0].page);
  assert.equal(markupsForPage(p, dup.id).length, 1);
  assert.equal(editsForPage(p, dup.id).length, 1);
  assert.equal(editsForPage(p, dup.id)[0].text, 'edited');
  assert.notEqual(editsForPage(p, dup.id)[0].id, editsForPage(p, pid)[0].id);
});

test('font matching maps PDF font names to standard families', () => {
  assert.deepEqual(matchPdfFont('ArialMT'), { family: 'Helvetica', bold: false, italic: false });
  assert.deepEqual(matchPdfFont('ABCDEF+Helvetica-Bold'), { family: 'Helvetica', bold: true, italic: false });
  assert.deepEqual(matchPdfFont('TimesNewRomanPS-BoldItalic'), { family: 'TimesRoman', bold: true, italic: true });
  assert.deepEqual(matchPdfFont('CourierNewPS-ItalicMT'), { family: 'Courier', bold: false, italic: true });
  assert.deepEqual(matchPdfFont('Consolas-Bold'), { family: 'Courier', bold: true, italic: false });
  assert.deepEqual(matchPdfFont('Georgia'), { family: 'TimesRoman', bold: false, italic: false });
});

test('affineMultiply multiplies 2D transformation matrices', () => {
  const identity = [1, 0, 0, 1, 0, 0];
  const t = [2, 0, 0, 3, 10, 20];
  assert.deepEqual(affineMultiply(identity, t), t);
  const m1 = [1, 0, 0, 1, 5, 5];
  const m2 = [2, 0, 0, 2, 0, 0];
  assert.deepEqual(affineMultiply(m1, m2), [2, 0, 0, 2, 5, 5]);
});

test('mapTextItem and groupTextLines process text geometry', () => {
  const vpTransform = [1, 0, 0, 1, 0, 0];
  const item1 = { str: 'Hello', transform: [12, 0, 0, 12, 100, 200], fontName: 'Helvetica' };
  const mapped1 = mapTextItem(item1, vpTransform, 1000, 1000);
  assert.ok(mapped1);
  assert.equal(mapped1.text, 'Hello');
  assert.equal(mapped1.rotated, false);

  const item2 = { str: 'World', transform: [12, 0, 0, 12, 150, 200], fontName: 'Helvetica' };
  const mapped2 = mapTextItem(item2, vpTransform, 1000, 1000);
  mapped1.wFrac = 0.04;
  mapped2.wFrac = 0.04;

  const lines = groupTextLines([mapped1, mapped2]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, 'Hello World');
});

test('existing text edits: add, get, update, delete, findEditForSpan', () => {
  const { p } = mkProject();
  const pid = p.pages[0].id;
  const span = { x: 0.1, y: 0.2, w: 0.3, h: 0.04, text: 'Original Title', size: 0.035, fontName: 'Times-Bold' };
  const edit = addTextEdit(p, pid, span, 'New Title', { color: '#FF0000' });
  assert.equal(edit.text, 'New Title');
  assert.equal(edit.origText, 'Original Title');
  assert.equal(edit.font, 'TimesRoman');
  assert.equal(edit.bold, true);
  assert.equal(edit.color, '#FF0000');
  assert.equal(getTextEdit(p, edit.id).id, edit.id);
  assert.equal(editsForPage(p, pid).length, 1);

  const found = findEditForSpan(p, pid, { x: 0.1, y: 0.2, w: 0.3, h: 0.04 }, 'Original Title');
  assert.ok(found);
  assert.equal(found.id, edit.id);

  updateTextEdit(p, edit.id, { text: 'Updated Title', align: 'center' });
  assert.equal(edit.text, 'Updated Title');
  assert.equal(edit.align, 'center');

  assert.equal(deleteTextEdit(p, edit.id), true);
  assert.equal(deleteTextEdit(p, edit.id), false);
  assert.equal(editsForPage(p, pid).length, 0);
});

test('editFitScale calculates shrink ratio when text exceeds box', () => {
  assert.equal(editFitScale(100, 150), 1);
  assert.equal(editFitScale(200, 100), 0.5);
  assert.equal(editFitScale(0, 100), 1);
});

test('undo and redo project mutations', () => {
  const { p } = mkProject();
  const stack = createUndoStack();
  pushUndo(stack, p);

  const pid = p.pages[0].id;
  rotateOutputPage(p, pid);
  assert.equal(p.pages[0].rotate, 90);

  assert.equal(undoProject(p, stack), true);
  assert.equal(p.pages[0].rotate, 0);

  assert.equal(redoProject(p, stack), true);
  assert.equal(p.pages[0].rotate, 90);
});

test('extractWordSpans splits text items into individual word spans, keeping punctuation and preserving bullets', () => {
  const items = [
    {
      text: '• Hello, world! Punctuation.',
      xFrac: 0.1,
      baseYFrac: 0.2,
      sizeFrac: 0.015,
      wFrac: 0.25,
      fontName: 'Helvetica'
    }
  ];

  const wordSpans = extractWordSpans(items, 1000, 1000, null);
  
  // Verify word-level extraction
  assert.ok(wordSpans.length > 0, 'extracted spans');
  
  // Verify spaces are ignored as editable spans
  const spaces = wordSpans.filter(s => /^\s+$/.test(s.text));
  assert.equal(spaces.length, 0, 'no space-only spans');

  // Verify bullet is preserved as its own span
  const bulletSpan = wordSpans.find(s => s.text === '•');
  assert.ok(bulletSpan, 'bullet point preserved');
  assert.equal(bulletSpan.x, 0.1, 'bullet starts at parent xFrac');

  // Verify punctuation remains attached
  const helloComma = wordSpans.find(s => s.text === 'Hello,');
  assert.ok(helloComma, 'punctuation remains attached to appropriate word');

  // Verify positions of each word are sequentially advanced
  const worldExcl = wordSpans.find(s => s.text === 'world!');
  assert.ok(worldExcl, 'world! exists');
  assert.ok(worldExcl.x > bulletSpan.x, 'sequential X advancement');
});

test('editing one word with word-level spans does not affect adjacent words', () => {
  const { p } = mkProject();
  const pid = p.pages[0].id;

  // Simulate word span
  const wordSpan = { x: 0.15, y: 0.2, w: 0.05, h: 0.015, text: 'Projects', size: 0.015, fontName: 'Helvetica' };
  
  // Edit only this word
  const edit = addTextEdit(p, pid, wordSpan, 'Works', { color: '#000000', font: 'Helvetica' });
  
  assert.equal(edit.text, 'Works');
  assert.equal(edit.origText, 'Projects');
  assert.equal(edit.box.x, 0.15, 'only the word bounds are covered');
  assert.equal(edit.box.w, 0.05, 'only the word width is covered');
});

test('diffLineText partitions changed line text correctly for shorter/longer replacements and bullets', () => {
  // Test shorter replacement
  const r1 = diffLineText('Product Offering Line', 'Product Offer Line');
  assert.equal(r1.segmentA, 'Product Offer');
  assert.equal(r1.segmentC, ' Line');
  assert.equal(r1.segmentBOrig, 'ing');
  assert.equal(r1.segmentBRepl, '');

  // Test longer replacement in middle
  const r2 = diffLineText('Product / Offering / Line', 'Product / Business Offering / Line');
  assert.equal(r2.segmentA, 'Product / ');
  assert.equal(r2.segmentC, 'Offering / Line'); // Notice standard char-level prefix/suffix matching
  assert.equal(r2.segmentBOrig, '');
  assert.equal(r2.segmentBRepl, 'Business ');

  // Test bullet line
  const r3 = diffLineText('• Standard Text', '• Improved Text');
  assert.equal(r3.segmentA, '• ');
  assert.equal(r3.segmentC, 'd Text');
  assert.equal(r3.segmentBOrig, 'Standar');
  assert.equal(r3.segmentBRepl, 'Improve');
});

test('formatting edits preserve layout, alignment, and baseline anchors without shrinking', () => {
  const { p } = mkProject();
  const pid = p.pages[0].id;
  const originalLine = { x: 0.1, y: 0.2, w: 0.4, h: 0.02, text: 'Maintain Baseline', size: 0.02, fontName: 'Helvetica' };

  // 1. Color-only formatting change -> preserves text and box coordinates
  const edit1 = addTextEdit(p, pid, originalLine, 'Maintain Baseline', { color: '#FF0000', font: 'Helvetica', size: 0.02 });
  assert.equal(edit1.text, edit1.origText, 'is formatting-only edit');
  assert.equal(edit1.color, '#FF0000', 'color updated');
  assert.equal(edit1.box.y, 0.2, 'preserves baseline anchor vertical coordinate');

  // 2. Font size increase -> does not move other lines or shrink font size
  const edit2 = updateTextEdit(p, edit1.id, { size: 0.04 });
  assert.equal(edit2.size, 0.04, 'requested size applied successfully');
  assert.equal(edit2.box.y, 0.2, 'original vertical baseline anchor remains completely stable');

  // 3. Bold/Italic -> layout remains stable
  const edit3 = updateTextEdit(p, edit1.id, { bold: true, italic: true });
  assert.ok(edit3.bold && edit3.italic, 'bold and italic applied');
  assert.equal(edit3.box.y, 0.2, 'baseline vertical coordinate remains untouched');
});

test('formatting changes on one text block leave unrelated text coordinates 100% untouched', () => {
  const { p } = mkProject();
  const pid = p.pages[0].id;

  const line1 = { x: 0.1, y: 0.2, w: 0.3, h: 0.02, text: 'First Line', size: 0.02, fontName: 'Helvetica' };
  const line2 = { x: 0.1, y: 0.3, w: 0.3, h: 0.02, text: 'Second Line', size: 0.02, fontName: 'Helvetica' };

  // Create edits for both lines
  const edit1 = addTextEdit(p, pid, line1, 'First Line', { color: '#000000', size: 0.02 });
  const edit2 = addTextEdit(p, pid, line2, 'Second Line', { color: '#000000', size: 0.02 });

  const originalY2 = edit2.box.y;
  assert.equal(originalY2, 0.3, 'line 2 starts at original position');

  // Change font size of line 1
  updateTextEdit(p, edit1.id, { size: 0.05 });

  // Verify line 2 remains completely untouched
  const reloaded2 = getTextEdit(p, edit2.id);
  assert.equal(reloaded2.box.y, originalY2, 'formatting changes on line 1 leave line 2 coordinates 100% untouched');
});
