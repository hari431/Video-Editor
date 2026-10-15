import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findPlaceholders,
  parseParameters,
  formatValue,
  parseLogs,
  stitchBlock
} from '../src/public/admin-developer-tools-sql-stitcher.js';

test('SQL Log Stitcher: findPlaceholders tests', async (t) => {
  await t.test('detects ? outside strings and comments', () => {
    const sql = 'SELECT * FROM pc_policyperiod WHERE ID = ? AND Status = ?';
    const places = findPlaceholders(sql);
    assert.deepEqual(places, [41, 56]);
  });

  await t.test('ignores ? inside single quotes', () => {
    const sql = "SELECT * FROM pc_policyperiod WHERE ID = ? AND Status = 'Bound?' AND Code = ?";
    const places = findPlaceholders(sql);
    // Should skip the ? in 'Bound?'
    assert.deepEqual(places, [41, 76]);
  });

  await t.test('ignores ? inside block comments', () => {
    const sql = "SELECT * FROM pc_policyperiod WHERE ID = ? /* is it active? */ AND Status = ?";
    const places = findPlaceholders(sql);
    assert.deepEqual(places, [41, 76]);
  });

  await t.test('ignores ? inside line comments', () => {
    const sql = "SELECT * FROM pc_policyperiod WHERE ID = ? -- is it ? \n AND Status = ?";
    const places = findPlaceholders(sql);
    assert.deepEqual(places, [41, 69]);
  });

  await t.test('handles escaped quotes inside single-quoted strings', () => {
    const sql = "SELECT * FROM pc_policyperiod WHERE Status = 'It''s ?' AND ID = ?";
    const places = findPlaceholders(sql);
    assert.deepEqual(places, [64]);
  });
});

test('SQL Log Stitcher: parseParameters tests', async (t) => {
  await t.test('parses multiple formatted parameters correctly', () => {
    const paramStr = "[Param: 1, Type: varchar, Value: 'Bound'], [Param: 2, Type: integer, Value: 12345]";
    const parsed = parseParameters(paramStr);
    assert.equal(parsed.length, 2);
    
    assert.equal(parsed[0].index, 1);
    assert.equal(parsed[0].type, 'varchar');
    assert.equal(parsed[0].value, "'Bound'");

    assert.equal(parsed[1].index, 2);
    assert.equal(parsed[1].type, 'integer');
    assert.equal(parsed[1].value, '12345');
  });

  await t.test('handles out of order indices by sorting them', () => {
    const paramStr = "[Param: 2, Type: integer, Value: 9], [Param: 1, Type: varchar, Value: 'Active']";
    const parsed = parseParameters(paramStr);
    assert.equal(parsed[0].index, 1);
    assert.equal(parsed[1].index, 2);
  });

  await t.test('parses null values properly', () => {
    const paramStr = "[Param: 1, Type: integer, Value: null]";
    const parsed = parseParameters(paramStr);
    assert.equal(parsed[0].value, 'null');
  });
});

test('SQL Log Stitcher: formatValue tests', async (t) => {
  await t.test('formats strings by escaping and wrapping', () => {
    assert.equal(formatValue('Bound', 'varchar'), "'Bound'");
    assert.equal(formatValue("O'Connor", 'varchar'), "'O''Connor'");
  });

  await t.test('keeps already-quoted values as is', () => {
    assert.equal(formatValue("'Bound'", 'varchar'), "'Bound'");
  });

  await t.test('formats booleans/bits correctly', () => {
    assert.equal(formatValue('true', 'boolean'), 'TRUE');
    assert.equal(formatValue('1', 'bit'), 'TRUE');
    assert.equal(formatValue('0', 'bit'), 'FALSE');
  });

  await t.test('formats numbers as unquoted numbers', () => {
    assert.equal(formatValue('12345', 'integer'), '12345');
    assert.equal(formatValue('12.34', 'double'), '12.34');
  });

  await t.test('formats literal null to NULL', () => {
    assert.equal(formatValue('null', 'varchar'), 'NULL');
  });
});

test('SQL Log Stitcher: parseLogs tests', async (t) => {
  await t.test('parses clean log streams with interleaved SQL and parameters', () => {
    const logs = `
10:00:00 DEBUG SELECT * FROM pc_policyperiod WHERE ID = ?
10:00:00 DEBUG Parameters: [Param: 1, Type: varchar, Value: 'abc']
10:00:01 DEBUG UPDATE pc_account SET Name = ? WHERE ID = ?
10:00:01 DEBUG Parameters: [Param: 1, Type: varchar, Value: 'Acme'], [Param: 2, Type: varchar, Value: 'xyz']
    `;
    const blocks = parseLogs(logs);
    assert.equal(blocks.length, 2);
    
    assert.equal(blocks[0].sql, 'SELECT * FROM pc_policyperiod WHERE ID = ?');
    assert.equal(blocks[0].paramsParsed.length, 1);
    assert.equal(blocks[0].paramsParsed[0].value, "'abc'");

    assert.equal(blocks[1].sql, 'UPDATE pc_account SET Name = ? WHERE ID = ?');
    assert.equal(blocks[1].paramsParsed.length, 2);
    assert.equal(blocks[1].paramsParsed[0].value, "'Acme'");
    assert.equal(blocks[1].paramsParsed[1].value, "'xyz'");
  });

  await t.test('handles multi-line SQL queries correctly', () => {
    const logs = `
SELECT * 
FROM pc_policyperiod
WHERE ID = ? AND Status = ?
Parameters: [Param: 1, Type: varchar, Value: 'abc'], [Param: 2, Type: varchar, Value: 'Bound']
    `;
    const blocks = parseLogs(logs);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].sql, 'SELECT *\nFROM pc_policyperiod\nWHERE ID = ? AND Status = ?');
  });
});

test('SQL Log Stitcher: stitchBlock integration tests', async (t) => {
  await t.test('stitches simple parameters successfully', () => {
    const block = {
      sql: 'SELECT * FROM pc_policyperiod WHERE ID = ? AND Status = ?',
      paramsParsed: [
        { index: 1, type: 'varchar', value: '01:99' },
        { index: 2, type: 'varchar', value: 'Bound' }
      ]
    };
    const stitched = stitchBlock(block);
    assert.equal(stitched.stitchedSql, "SELECT * FROM pc_policyperiod WHERE ID = '01:99' AND Status = 'Bound'");
    assert.equal(stitched.warnings, null);
  });

  await t.test('handles missing parameters with warning and commented placeholder', () => {
    const block = {
      sql: 'SELECT * FROM pc_policyperiod WHERE ID = ? AND Status = ?',
      paramsParsed: [
        { index: 1, type: 'varchar', value: '01:99' }
      ]
    };
    const stitched = stitchBlock(block);
    assert.equal(stitched.stitchedSql, "SELECT * FROM pc_policyperiod WHERE ID = '01:99' AND Status = /* MISSING: Param 2 */ ?");
    assert.ok(stitched.warnings);
    assert.match(stitched.warnings[0], /Parameter 2 is missing/);
  });
});
