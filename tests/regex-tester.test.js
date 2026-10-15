import test from 'node:test';
import assert from 'node:assert/strict';
import { runRegexTest } from '../src/public/admin-developer-tools-regex-tester.js';

test('Regex Tester - Matching & Capturing', async (t) => {

  await t.test('should correctly test match patterns and capture groups', () => {
    const pattern = 'cc-(\\d{6})';
    const text = 'ClaimCenter number cc-129481 was logged.';
    const flags = 'g';

    const res = runRegexTest(pattern, text, flags);
    assert.equal(res.success, true);
    assert.equal(res.matches.length, 1);
    assert.equal(res.matches[0].text, 'cc-129481');
    assert.deepEqual(res.matches[0].groups, ['129481']);
  });

  await t.test('should securely handle invalid regex structures', () => {
    const pattern = '(unclosed-bracket';
    const res = runRegexTest(pattern, 'test text', 'g');
    assert.equal(res.success, false);
    assert.ok(res.error);
  });

  await t.test('should compute text replacement mapping cleanly', () => {
    const pattern = 'cc-(\\d{6})';
    const text = 'claim cc-129481';
    const res = runRegexTest(pattern, text, 'g', 'REPLACED_$1');

    assert.equal(res.success, true);
    assert.equal(res.replacedText, 'claim REPLACED_129481');
  });
});
