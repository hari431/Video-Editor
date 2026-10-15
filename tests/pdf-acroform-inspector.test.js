import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import {
  inspectAcroFormFields,
  findFieldPage,
  findFieldCoords
} from '../src/library/pdf-acroform-inspector.js';

// Helper to programmatically create a fillable PDF with standard form fields
async function createTestFormPdf() {
  const pdfDoc = await PDFDocument.create();
  const page1 = pdfDoc.addPage([600, 400]);
  const page2 = pdfDoc.addPage([600, 400]);

  const form = pdfDoc.getForm();

  // 1. Text Field on Page 1
  const textField = form.createTextField('firstName');
  textField.setText('Gosu Expert');
  textField.addToPage(page1, { x: 50, y: 300, width: 200, height: 30 });

  // 2. Checkbox Field on Page 1
  const checkboxField = form.createCheckBox('isDeveloper');
  checkboxField.check();
  checkboxField.addToPage(page1, { x: 50, y: 250, width: 20, height: 20 });

  // 3. Radio Group on Page 2
  const radioGroup = form.createRadioGroup('experience');
  radioGroup.addOptionToPage('junior', page2, { x: 50, y: 200, width: 20, height: 20 });
  radioGroup.addOptionToPage('senior', page2, { x: 50, y: 150, width: 20, height: 20 });
  radioGroup.select('senior');

  // 4. Dropdown Field on Page 2
  const dropdownField = form.createDropdown('lob');
  dropdownField.setOptions(['Personal Auto', 'Commercial Auto', 'Workers Comp']);
  dropdownField.select('Commercial Auto');
  dropdownField.addToPage(page2, { x: 50, y: 100, width: 150, height: 25 });

  const bytes = await pdfDoc.save();
  return bytes;
}

// Helper to programmatically create a blank PDF with NO fields
async function createBlankPdf() {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.addPage([600, 400]);
  const bytes = await pdfDoc.save();
  return bytes;
}

test('PDF AcroForm Field Inspector - Core Inspection', async (t) => {

  await t.test('inspectAcroFormFields should extract text fields and values', async () => {
    const pdfBytes = await createTestFormPdf();
    const fields = await inspectAcroFormFields(pdfBytes);

    const txtField = fields.find(f => f.name === 'firstName');
    assert.ok(txtField);
    assert.equal(txtField.type, 'Text');
    assert.equal(txtField.value, 'Gosu Expert');
    assert.equal(txtField.page, 1);
    assert.deepEqual(txtField.coords, { x: 50, y: 300, width: 201, height: 31 });
  });

  await t.test('inspectAcroFormFields should extract checkbox fields and values', async () => {
    const pdfBytes = await createTestFormPdf();
    const fields = await inspectAcroFormFields(pdfBytes);

    const chkField = fields.find(f => f.name === 'isDeveloper');
    assert.ok(chkField);
    assert.equal(chkField.type, 'Checkbox');
    assert.equal(chkField.value, 'Checked');
    assert.equal(chkField.page, 1);
  });

  await t.test('inspectAcroFormFields should extract radio fields across multiple pages', async () => {
    const pdfBytes = await createTestFormPdf();
    const fields = await inspectAcroFormFields(pdfBytes);

    const radField = fields.find(f => f.name === 'experience');
    assert.ok(radField);
    assert.equal(radField.type, 'Radio');
    assert.equal(radField.value, 'senior');
    assert.equal(radField.page, 2); // Placed on page 2
    assert.deepEqual(radField.flags.options, ['junior', 'senior']);
  });

  await t.test('inspectAcroFormFields should extract dropdown choices and settings', async () => {
    const pdfBytes = await createTestFormPdf();
    const fields = await inspectAcroFormFields(pdfBytes);

    const dropField = fields.find(f => f.name === 'lob');
    assert.ok(dropField);
    assert.equal(dropField.type, 'Dropdown');
    assert.equal(dropField.value, 'Commercial Auto');
    assert.equal(dropField.page, 2);
    assert.deepEqual(dropField.flags.options, ['Personal Auto', 'Commercial Auto', 'Workers Comp']);
  });

  await t.test('inspectAcroFormFields should handle PDFs with no forms gracefully', async () => {
    const pdfBytes = await createBlankPdf();
    const fields = await inspectAcroFormFields(pdfBytes);
    assert.deepEqual(fields, []);
  });

  await t.test('inspectAcroFormFields should handle corrupted/invalid PDFs with clear errors', async () => {
    const invalidBytes = new Uint8Array([1, 2, 3, 4, 5]);
    await assert.rejects(
      inspectAcroFormFields(invalidBytes),
      /Invalid or corrupted PDF file/
    );
  });

  await t.test('inspectAcroFormFields should successfully parse the synthetic sample PDF generated for the applet', async () => {
    // We import and test the PDF creation programmatically
    const pdfDoc = await PDFDocument.create();
    const page1 = pdfDoc.addPage([600, 400]);
    const page2 = pdfDoc.addPage([600, 400]);
    const form = pdfDoc.getForm();

    const textField = form.createTextField('sample_firstName');
    textField.setText('Gosu Developer');
    textField.addToPage(page1, { x: 50, y: 300, width: 200, height: 30 });

    const checkboxField = form.createCheckBox('sample_isActive');
    checkboxField.check();
    checkboxField.addToPage(page1, { x: 50, y: 250, width: 20, height: 20 });

    const radioGroup = form.createRadioGroup('sample_role');
    radioGroup.addOptionToPage('admin', page2, { x: 50, y: 200, width: 20, height: 20 });
    radioGroup.addOptionToPage('user', page2, { x: 50, y: 150, width: 20, height: 20 });
    radioGroup.select('admin');

    const dropdownField = form.createDropdown('sample_product');
    dropdownField.setOptions(['PolicyCenter', 'ClaimCenter', 'BillingCenter']);
    dropdownField.select('PolicyCenter');
    dropdownField.addToPage(page2, { x: 50, y: 100, width: 150, height: 25 });

    const bytes = await pdfDoc.save();
    const fields = await inspectAcroFormFields(bytes);

    assert.equal(fields.length, 4);
    assert.equal(fields.find(f => f.name === 'sample_firstName').value, 'Gosu Developer');
    assert.equal(fields.find(f => f.name === 'sample_isActive').value, 'Checked');
    assert.equal(fields.find(f => f.name === 'sample_role').value, 'admin');
    assert.equal(fields.find(f => f.name === 'sample_product').value, 'PolicyCenter');
  });
});
