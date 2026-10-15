import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

test('File Hash & Signature Inspector - Cryptographic Checksums', async (t) => {

  await t.test('should calculate correct SHA-256 hex checksums on synthetic buffers', () => {
    const rawData = 'Guidewire Gosu Learning Portal 2026';
    const hash = crypto.createHash('sha256').update(rawData).digest('hex');

    // Expected known hash value
    const expected = 'fdf8099043b8c89da56a0c2a2db275962a5d81fcff51b713e51ce411911b22f7';
    assert.equal(hash, expected);
  });
});

test('File Hash & Signature Inspector - Binary Signature Analysis', async (t) => {

  await t.test('should correctly identify standard binary magic bytes', () => {
    // Magic headers
    const pngHeader = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    const pdfHeader = Buffer.from([0x25, 0x50, 0x44, 0x46]);
    const zipHeader = Buffer.from([0x50, 0x4B, 0x03, 0x04]);

    assert.ok(pngHeader.toString('hex').startsWith('89504e47'));
    assert.ok(pdfHeader.toString('hex').startsWith('25504446'));
    assert.ok(zipHeader.toString('hex').startsWith('504b0304'));
  });
});
