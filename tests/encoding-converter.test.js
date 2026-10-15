import test from 'node:test';
import assert from 'node:assert/strict';
import { runEncoding } from '../src/public/admin-developer-tools-encoding-converter.js';

test('Encoding Converter - Data Transformations', async (t) => {

  await t.test('should securely encode and decode Base64 data with unicode safety', () => {
    const raw = 'Gosu & Unicode test: 🚀';
    const encoded = runEncoding(raw, 'base64', 'encode');
    const decoded = runEncoding(encoded, 'base64', 'decode');

    assert.equal(decoded, raw);
  });

  await t.test('should handle URL encoding and decoding cleanly', () => {
    const raw = 'https://guidewire.com/pcf?id=1&name=test';
    const encoded = runEncoding(raw, 'url', 'encode');
    const decoded = runEncoding(encoded, 'url', 'decode');

    assert.equal(decoded, raw);
    assert.ok(encoded.includes('%3A%2F%2F'));
  });

  await t.test('should handle HTML entity escaping cleanly', () => {
    const raw = '<div>Test & "quote"</div>';
    const encoded = runEncoding(raw, 'html', 'encode');

    assert.equal(encoded, '&lt;div&gt;Test &amp; &quot;quote&quot;&lt;/div&gt;');
  });

  await t.test('should convert and revert Unicode Escape patterns', () => {
    const raw = 'Gosu';
    const escaped = runEncoding(raw, 'unicode', 'encode');
    const unescaped = runEncoding(escaped, 'unicode', 'decode');

    assert.equal(escaped, '\\u0047\\u006F\\u0073\\u0075');
    assert.equal(unescaped, raw);
  });
});
