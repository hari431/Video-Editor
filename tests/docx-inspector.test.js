import test from 'node:test';
import assert from 'node:assert/strict';
import mammoth from 'mammoth';
import JSZip from 'jszip';

test('DOCX Structural Inspector - Word Document Generation & Mammoth Parsing', async (t) => {

  await t.test('should construct a valid synthetic DOCX with headings and paragraphs, and mammoth should extract it', async () => {
    const zip = new JSZip();

    zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);

    zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);

    zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:pPr>
        <w:pStyle w:val="Heading1"/>
      </w:pPr>
      <w:r>
        <w:t>Claim Status report</w:t>
      </w:r>
    </w:p>
    <w:p>
      <w:r>
        <w:t>This is a synthetic document representing Claim {{ClaimNumber}}.</w:t>
      </w:r>
    </w:p>
  </w:body>
</w:document>`);

    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    
    // Test conversion
    const htmlResult = await mammoth.convertToHtml({ buffer });
    const textResult = await mammoth.extractRawText({ buffer });

    const html = htmlResult.value;
    const rawText = textResult.value;

    assert.ok(html.includes('<h1>Claim Status report</h1>'));
    assert.ok(html.includes('<p>This is a synthetic document representing Claim {{ClaimNumber}}.</p>'));
    assert.ok(rawText.includes('Claim Status report'));
    assert.ok(rawText.includes('{{ClaimNumber}}'));

    // Test placeholder detection regex
    const placeholders = rawText.match(/\{\{[^{}\r\n]+\}\}/g);
    assert.equal(placeholders.length, 1);
    assert.equal(placeholders[0], '{{ClaimNumber}}');
  });
});
