import test from 'node:test';
import assert from 'node:assert/strict';
import { convertFromUnix, convertFromIso } from '../src/public/admin-developer-tools-timestamp-converter.js';

test('Timestamp Converter - Formats & Zones', async (t) => {

  await t.test('should convert unix seconds vs milliseconds to standard JS dates', () => {
    // 1577836800 seconds
    const date1 = convertFromUnix('1577836800');
    assert.equal(date1.getTime(), 1577836800000);

    // 1577836800000 milliseconds
    const date2 = convertFromUnix('1577836800000');
    assert.equal(date2.getTime(), 1577836800000);
  });

  await t.test('should parse valid ISO-8601 calendar dates successfully', () => {
    const date = convertFromIso('2020-01-01T00:00:00.000Z');
    assert.equal(date.getTime(), 1577836800000);
  });

  await t.test('should gracefully handle invalid entries with clean assertions', () => {
    assert.throws(() => convertFromUnix('abc'), /Timestamp must contain numbers only/);
    assert.throws(() => convertFromIso('invalid-date-format'), /Invalid ISO 8601/);
  });
});
