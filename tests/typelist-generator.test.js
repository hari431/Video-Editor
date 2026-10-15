import test from 'node:test';
import assert from 'node:assert/strict';
import {
  escapeXmlValue,
  generateTypelistXml
} from '../src/public/admin-developer-tools-typelist-generator.js';

test('Guidewire Typelist Generator - XML Escaping & Security', async (t) => {

  await t.test('escapeXmlValue should safely escape XML special characters to prevent markup breaking', () => {
    assert.equal(escapeXmlValue('Test & "Text" <Value>'), 'Test &amp; &quot;Text&quot; &lt;Value&gt;');
    assert.equal(escapeXmlValue(null), '');
    assert.equal(escapeXmlValue(undefined), '');
  });
});

test('Guidewire Typelist Generator - XML Creation & Structure', async (t) => {

  await t.test('generateTypelistXml should construct valid .tti Typelist definitions with category fields', () => {
    const payload = {
      name: 'CustomStatus',
      desc: 'Custom insurance statuses & modes',
      format: 'tti',
      typecodes: [
        { code: 'tc_1', name: 'Draft', desc: 'Draft description', priority: '1', category: 'PersonalAuto', parent: 'p_1', retired: false }
      ]
    };

    const xml = generateTypelistXml(payload);
    assert.ok(xml.includes('<?xml version="1.0" encoding="UTF-8"?>'));
    assert.ok(xml.includes('<typelist xmlns="http://guidewire.com/typelists"'));
    assert.ok(xml.includes('name="CustomStatus"'));
    assert.ok(xml.includes('desc="Custom insurance statuses &amp; modes"'));
    assert.ok(xml.includes('code="tc_1" name="Draft" desc="Draft description" priority="1"'));
    assert.ok(xml.includes('<category code="PersonalAuto"/>'));
    assert.ok(xml.includes('<category code="p_1"/>'));
    assert.ok(xml.includes('</typelist>'));
  });

  await t.test('generateTypelistXml should output retired attributes and omit category tags when empty', () => {
    const payload = {
      name: 'ClaimType',
      desc: 'Claim types definition',
      format: 'tti',
      typecodes: [
        { code: 'auto', name: 'Auto', desc: 'Auto insurance', priority: '1', category: '', parent: '', retired: true }
      ]
    };

    const xml = generateTypelistXml(payload);
    assert.ok(xml.includes('retired="true"'));
    // Category tag should be completely omitted since both are empty strings
    assert.ok(!xml.includes('<category'));
  });

  await t.test('generateTypelistXml should correctly construct .ttx Typelist Extensions', () => {
    const payload = {
      name: 'ExistingStatus',
      format: 'ttx',
      typecodes: [
        { code: 'extended_code', name: 'Extended', desc: 'Extended code', priority: '', category: '', parent: '', retired: false }
      ]
    };

    const xml = generateTypelistXml(payload);
    assert.ok(xml.includes('<typelistextension xmlns="http://guidewire.com/typelists" name="ExistingStatus">'));
    assert.ok(xml.includes('code="extended_code"'));
    assert.ok(xml.includes('</typelistextension>'));
  });

  await t.test('generateTypelistXml should construct .fnt Filter Definitions containing include tags', () => {
    const payload = {
      name: 'PolicyStatus',
      format: 'fnt',
      typecodes: [
        { code: 'draft', name: '', desc: '', priority: '', category: '', parent: '', retired: false }
      ]
    };

    const xml = generateTypelistXml(payload);
    assert.ok(xml.includes('<typelistfilter xmlns="http://guidewire.com/typelists" name="Filter_PolicyStatus" typelist="PolicyStatus">'));
    assert.ok(xml.includes('<include code="draft"/>'));
    assert.ok(xml.includes('</typelistfilter>'));
  });
});

test('Guidewire Typelist Generator - Code Ordering Preservation', async (t) => {

  await t.test('generateTypelistXml should preserve order of typecode elements exactly as provided in parameters array', () => {
    const payload = {
      name: 'OrderTest',
      desc: 'Checking order preservation',
      format: 'tti',
      typecodes: [
        { code: 'first', name: 'First', desc: '', priority: '', category: '', parent: '', retired: false },
        { code: 'second', name: 'Second', desc: '', priority: '', category: '', parent: '', retired: false },
        { code: 'third', name: 'Third', desc: '', priority: '', category: '', parent: '', retired: false }
      ]
    };

    const xml = generateTypelistXml(payload);
    const posFirst = xml.indexOf('code="first"');
    const posSecond = xml.indexOf('code="second"');
    const posThird = xml.indexOf('code="third"');

    assert.ok(posFirst < posSecond);
    assert.ok(posSecond < posThird);
  });
});
