import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeJwtPure, formatJwtTimestamp } from '../src/public/admin-developer-tools-jwt-decoder.js';

test('JWT Decoder - Local Parsing', async (t) => {

  await t.test('should parse and extract JWT header and payload claims offline', () => {
    // Completely synthetic test token
    // Header: {"alg":"HS256","typ":"JWT"} -> eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9
    // Payload: {"iss":"GW","sub":"admin","exp":1893456000} -> eyJpc3MiOiJHdyIsInN1YiI6ImFkbWluIiwiZXhwIjoxODkzNDU2MDAwfQ
    const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJHdyIsInN1YiI6ImFkbWluIiwiZXhwIjoxODkzNDU2MDAwfQ.SignatureString';

    const decoded = decodeJwtPure(token);
    assert.deepEqual(decoded.header, { alg: 'HS256', typ: 'JWT' });
    assert.equal(decoded.payload.iss, 'Gw');
    assert.equal(decoded.payload.sub, 'admin');
    assert.equal(decoded.payload.exp, 1893456000);
    assert.equal(decoded.signature, 'SignatureString');
  });

  await t.test('should gracefully handle malformed tokens without throwing unhandled exceptions', () => {
    assert.throws(() => decodeJwtPure('malformed-token-string'), /Invalid JWT format/);
    assert.throws(() => decodeJwtPure('a.b'), /Invalid JWT format/);
  });

  await t.test('should format Unix timestamps to readable UTC date strings', () => {
    const formatted = formatJwtTimestamp(1577836800); // 2020-01-01T00:00:00.000Z
    assert.ok(formatted.includes('Wed, 01 Jan 2020 00:00:00 GMT'));
  });
});
