import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCsvPure,
  detectDelimiter,
  analyzeCsvData
} from '../src/public/admin-developer-tools-csv-analyzer.js';

test('CSV / TSV Analyzer - Parser RFC-4180 Compliance', async (t) => {

  await t.test('should parse simple clean CSV files with standard rows', () => {
    const raw = 'name,age,city\nJohn,30,Dallas\nJane,25,Boston';
    const parsed = parseCsvPure(raw, ',');

    assert.equal(parsed.length, 3);
    assert.deepEqual(parsed[0], ['name', 'age', 'city']);
    assert.deepEqual(parsed[1], ['John', '30', 'Dallas']);
    assert.deepEqual(parsed[2], ['Jane', '25', 'Boston']);
  });

  await t.test('should parse cell strings containing commas inside quotes correctly', () => {
    const raw = 'id,name,description\n1,"Doe, John",Standard description\n2,"Smith, Jane","Cell with , comma inside"';
    const parsed = parseCsvPure(raw, ',');

    assert.equal(parsed.length, 3);
    assert.equal(parsed[1][1], 'Doe, John');
    assert.equal(parsed[2][2], 'Cell with , comma inside');
  });

  await t.test('should support escaped double quotes within cells', () => {
    const raw = 'id,quote\n1,"He said ""hello"" to me"';
    const parsed = parseCsvPure(raw, ',');

    assert.equal(parsed.length, 2);
    assert.equal(parsed[1][1], 'He said "hello" to me');
  });
});

test('CSV / TSV Analyzer - Delimiter Detection & Audit Checks', async (t) => {

  await t.test('should accurately identify delimiter density', () => {
    assert.equal(detectDelimiter('a,b,c,d\n1,2,3,4'), ',');
    assert.equal(detectDelimiter('a\tb\tc\n1\t2\t3'), '\t');
    assert.equal(detectDelimiter('a;b;c;d\n1;2;3;4'), ';');
  });

  await t.test('should identify duplicate headers, empty columns, and inconsistent row structures', () => {
    // CC-1 row has only 2 fields instead of 3 (inconsistent)
    // age column is completely empty for all data rows
    const rows = [
      ['id', 'id', 'age'],
      ['CC-1', 'Open'],
      ['CC-2', 'Closed', '']
    ];

    const audit = analyzeCsvData(rows);

    assert.deepEqual(audit.duplicateHeaders, ['id']);
    assert.equal(audit.inconsistentRows.length, 1);
    assert.equal(audit.inconsistentRows[0].rowIndex, 1);
    assert.equal(audit.inconsistentRows[0].got, 2);
    assert.equal(audit.inconsistentRows[0].expected, 3);
    assert.deepEqual(audit.emptyColumns, ['age']);
  });
});
