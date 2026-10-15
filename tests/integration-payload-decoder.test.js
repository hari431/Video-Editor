import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import {
  decodeBase64,
  decodeHex,
  bytesToString,
  decompressGzip,
  decodeHtmlEntities,
  formatXml,
  formatJson,
  isReadableText,
  decodePayloadChain
} from '../src/public/admin-developer-tools-payload-decoder.js';

test('Integration Payload Decoder - Core Decoder Utilities', async (t) => {
  
  await t.test('decodeBase64 should correctly decode base64 strings to bytes', () => {
    const original = 'Hello Guidewire!';
    const b64 = Buffer.from(original).toString('base64');
    const decodedBytes = decodeBase64(b64);
    const decodedStr = new TextDecoder().decode(decodedBytes);
    assert.equal(decodedStr, original);
  });

  await t.test('decodeHex should correctly decode hex strings to bytes', () => {
    const original = 'Gosu Rulez';
    const hex = Buffer.from(original).toString('hex');
    const decodedBytes = decodeHex(hex);
    const decodedStr = new TextDecoder().decode(decodedBytes);
    assert.equal(decodedStr, original);
  });

  await t.test('bytesToString should decode valid UTF-8 and return null for invalid UTF-8', () => {
    const validBytes = new Uint8Array([71, 111, 115, 117]); // "Gosu"
    assert.equal(bytesToString(validBytes), 'Gosu');

    const invalidBytes = new Uint8Array([0x80, 0x81, 0x82]); // Invalid UTF-8 sequence
    assert.equal(bytesToString(invalidBytes), null);
  });

  await t.test('decodeHtmlEntities should restore escaped chars', () => {
    const escaped = 'XML &lt;payload id=&quot;1&quot; &amp; status=&apos;active&apos;&gt;';
    const decoded = decodeHtmlEntities(escaped);
    assert.equal(decoded, 'XML <payload id="1" & status=\'active\'>');
  });

  await t.test('formatJson should format mini JSON with indentation', () => {
    const mini = '{"a":1,"b":[2,3],"c":{"d":"e"}}';
    const formatted = formatJson(mini);
    assert.ok(formatted.includes('  "a": 1'));
    assert.ok(formatted.includes('  "b": [\n    2,\n    3\n  ]'));
  });

  await t.test('formatXml should format mini XML with indentation', () => {
    const xml = '<root><child id="1">Gosu</child><selfClose/></root>';
    const formatted = formatXml(xml);
    const expected = '<root>\n  <child id="1">Gosu</child>\n  <selfClose/>\n</root>';
    assert.equal(formatted.trim(), expected.trim());
  });

  await t.test('isReadableText should identify binary vs plain text', () => {
    assert.equal(isReadableText('Hello World!\nSome standard logs.'), true);
    // binary bytes with control chars
    const binaryStr = String.fromCharCode(0, 1, 2, 3, 4, 12, 14, 15);
    assert.equal(isReadableText(binaryStr), false);
  });
});

test('Integration Payload Decoder - Decompression & Nested Layers Chain', async (t) => {

  await t.test('decompressGzip should correctly decompress gzipped bytes', async () => {
    const payload = 'Super secret payload that is compressed with gzip to save bandwith in SOAP!';
    const gzipped = zlib.gzipSync(Buffer.from(payload));
    const decompressedBytes = await decompressGzip(new Uint8Array(gzipped));
    const result = bytesToString(decompressedBytes);
    assert.equal(result, payload);
  });

  await t.test('decodePayloadChain should decode URL-encoded Base64 string', async () => {
    const secret = '{"user":"gw_admin","role":"integration"}';
    const b64 = Buffer.from(secret).toString('base64');
    const urlEncoded = encodeURIComponent(b64);
    
    const result = await decodePayloadChain(urlEncoded);
    assert.equal(result.steps.length, 4); // Original -> URL Decoded -> Base64 Decoded -> JSON Formatted
    assert.ok(result.finalValue.includes('"user": "gw_admin"'));
  });

  await t.test('decodePayloadChain should recursively decompress Base64 + Gzipped payload', async () => {
    const payload = '{"guidewire_event":"ClaimCreated","claim_number":"47-219381"}';
    const gzipped = zlib.gzipSync(Buffer.from(payload));
    const b64 = gzipped.toString('base64');

    const result = await decodePayloadChain(b64);
    // Original -> Base64 + Gzip -> JSON Formatted
    assert.ok(result.steps.some(s => s.title.includes('Gzip decompressed')));
    assert.ok(result.finalValue.includes('"claim_number": "47-219381"'));
  });

  await t.test('decodePayloadChain should auto-detect and extract nested Base64-Gzipped payload inside XML', async () => {
    // Let's build a SOAP envelope with a base64-gzipped nested tag
    const innerPayload = '{"policyNumber":"90-123456","status":"bound"}';
    const gzipped = zlib.gzipSync(Buffer.from(innerPayload));
    const b64 = gzipped.toString('base64');

    const soap = `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
   <soapenv:Body>
      <gw:execute>
         <gw:payload>${b64}</gw:payload>
      </gw:execute>
   </soapenv:Body>
</soapenv:Envelope>`;

    const result = await decodePayloadChain(soap);
    assert.ok(result.steps.some(s => s.title.includes('XML / SOAP Formatted')));
    assert.equal(result.nested.length, 1);
    assert.equal(result.nested[0].path, '<gw:payload>');
    assert.ok(result.nested[0].type.includes('Base64 + Gzip Decompressed'));
    assert.equal(result.nested[0].decoded, innerPayload);
  });
  
  await t.test('decodePayloadChain should auto-detect and extract nested Base64 payloads inside JSON', async () => {
    const innerJson = '{"correlationId":"abc-xyz-123"}';
    const b64 = Buffer.from(innerJson).toString('base64');
    const parentJson = JSON.stringify({
      status: "success",
      embedded_data: b64
    });

    const result = await decodePayloadChain(parentJson);
    assert.equal(result.nested.length, 1);
    assert.equal(result.nested[0].path, 'root.embedded_data');
    assert.equal(result.nested[0].decoded, innerJson);
  });
});
