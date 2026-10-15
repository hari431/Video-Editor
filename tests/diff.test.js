import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sortJsonKeys,
  normalizeJson,
  normalizeXml,
  computeLineDiff,
  runDiff
} from '../src/public/admin-developer-tools-diff.js';

test('JSON / XML / Text Diff - Normalization Utilities', async (t) => {

  await t.test('sortJsonKeys should recursively sort keys in objects and keep array structures', () => {
    const original = { z: 1, a: { y: 2, b: 3 }, c: [4, { e: 5, d: 6 }] };
    const sorted = sortJsonKeys(original);

    // Verify ordering
    assert.deepEqual(Object.keys(sorted), ['a', 'c', 'z']);
    assert.deepEqual(Object.keys(sorted.a), ['b', 'y']);
    assert.deepEqual(Object.keys(sorted.c[1]), ['d', 'e']);
  });

  await t.test('normalizeJson should standardise JSON structure and throw on malformed input', () => {
    const raw = '{\n  "z": 1,\n  "a": 2\n}';
    const normalized = normalizeJson(raw);
    const expected = '{\n  "a": 2,\n  "z": 1\n}';
    assert.equal(normalized, expected);

    assert.throws(() => normalizeJson('{ invalid_json }'), SyntaxError);
  });

  await t.test('normalizeXml should standardise XML indentation and spacing', () => {
    const rawXml = '<root>   <child id="1">Text</child>   <selfClose/>   </root>';
    const expected = '<root>\n  <child id="1">Text</child>\n  <selfClose/>\n</root>';
    const normalized = normalizeXml(rawXml);
    assert.equal(normalized.trim(), expected.trim());
  });
});

test('JSON / XML / Text Diff - Line-by-Line Core LCS Diff Engine', async (t) => {

  await t.test('computeLineDiff should handle identical text outputs', () => {
    const lines = ['line 1', 'line 2'];
    const diff = computeLineDiff(lines, lines);
    assert.equal(diff.length, 2);
    assert.ok(diff.every(d => d.type === 'unchanged'));
    assert.equal(diff[0].oldLineNum, 1);
    assert.equal(diff[1].newLineNum, 2);
  });

  await t.test('computeLineDiff should identify added and removed lines', () => {
    const oldLines = ['line 1', 'line 2'];
    const newLines = ['line 1', 'line 3'];

    const diff = computeLineDiff(oldLines, newLines);
    // line 1 unchanged, line 2 removed, line 3 added
    assert.equal(diff.length, 3);
    assert.equal(diff[0].type, 'unchanged');
    assert.equal(diff[1].type, 'removed');
    assert.equal(diff[1].value, 'line 2');
    assert.equal(diff[2].type, 'added');
    assert.equal(diff[2].value, 'line 3');
  });

  await t.test('computeLineDiff should handle empty inputs safely', () => {
    const diff = computeLineDiff([], []);
    assert.deepEqual(diff, []);
  });
});

test('JSON / XML / Text Diff - End-to-End Orchestrator', async (t) => {

  await t.test('runDiff should detect identical JSON contents regardless of spacing or key order', () => {
    const jsonLeft = '{\n  "version": "1.0",\n  "status": "active"\n}';
    const jsonRight = '{\n  "status": "active",\n  "version": "1.0"\n}';

    const result = runDiff(jsonLeft, jsonRight, 'json');
    assert.equal(result.mode, 'json');
    assert.equal(result.error, null);
    assert.ok(result.items.every(d => d.type === 'unchanged'));
  });

  await t.test('runDiff should highlight JSON value changes correctly', () => {
    const jsonLeft = '{"status": "active"}';
    const jsonRight = '{"status": "inactive"}';

    const result = runDiff(jsonLeft, jsonRight, 'json');
    assert.equal(result.mode, 'json');
    assert.equal(result.items.length, 4); // { -> - "status": "active" -> + "status": "inactive" -> }
    assert.equal(result.items[1].type, 'removed');
    assert.equal(result.items[2].type, 'added');
  });

  await t.test('runDiff should detect XML spacing/formatting changes as identical in XML mode', () => {
    const xmlLeft = '<tag   attr="val"  >text</tag>';
    const xmlRight = '<tag attr="val">text</tag>';

    const result = runDiff(xmlLeft, xmlRight, 'xml');
    assert.equal(result.mode, 'xml');
    assert.equal(result.error, null);
    assert.ok(result.items.every(d => d.type === 'unchanged'));
  });

  await t.test('runDiff should identify XML tag or attribute changes', () => {
    const xmlLeft = '<tag attr="val">text</tag>';
    const xmlRight = '<tag attr="diff">text</tag>';

    const result = runDiff(xmlLeft, xmlRight, 'xml');
    assert.equal(result.mode, 'xml');
    assert.equal(result.items[0].type, 'removed');
    assert.equal(result.items[1].type, 'added');
  });

  await t.test('runDiff should fall back gracefully on invalid JSON/XML', () => {
    const invalidJson = '{"status": "active"'; // Missing closing brace
    const validJson = '{"status": "active"}';

    const result = runDiff(invalidJson, validJson, 'json');
    assert.equal(result.mode, 'text');
    assert.ok(result.error.includes('Left input is invalid JSON'));
  });
});
