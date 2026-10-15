import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { readLibraryContent, formatTimestamp } from '../src/luna/content-reader.js';

test('formatTimestamp formats transcript positions', () => {
  assert.equal(formatTimestamp(0), '0:00');
  assert.equal(formatTimestamp(65_000), '1:05');
  assert.equal(formatTimestamp(3_661_000), '1:01:01');
});

test('Luna content reader reads plain text files from the library root', async () => {
  const relPath = '.luna-reader-test.txt';
  const absPath = path.join(process.cwd(), 'queries', relPath);
  await mkdir(path.dirname(absPath), { recursive: true });
  try {
    await writeFile(absPath, 'PolicyCenter quoting uses rating to calculate costs.');
    const result = await readLibraryContent(relPath);
    assert.equal(result.meta.type, 'text');
    assert.match(result.text, /PolicyCenter quoting/);
  } finally {
    await rm(absPath, { force: true });
  }
});

test('PDF extraction reads text from a real PDF fixture', async () => {
  const relPath = '.luna-reader-test.pdf';
  const absPath = path.join(process.cwd(), 'queries', relPath);
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  page.drawText('Guidewire PolicyCenter rating test document', {
    x: 40,
    y: 700,
    size: 14,
    font
  });
  const bytes = await pdfDoc.save();
  await mkdir(path.dirname(absPath), { recursive: true });
  try {
    await writeFile(absPath, bytes);
    const result = await readLibraryContent(relPath);
    assert.equal(result.meta.type, 'pdf');
    assert.match(result.text, /PolicyCenter rating test document/);
    assert.equal(result.meta.pages, 1);
  } finally {
    await rm(absPath, { force: true });
  }
});
