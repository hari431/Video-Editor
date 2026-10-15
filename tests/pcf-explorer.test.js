import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseXmlPure,
  formatXmlPCF,
  searchNodes
} from '../src/public/admin-developer-tools-pcf-explorer.js';

test('PCF / XML Path Explorer - Basic Validation & Stats', async (t) => {

  await t.test('parseXmlPure should parse valid XML and return correct element statistics', () => {
    const rawXml = `<?xml version="1.0"?>
    <root attr1="val1">
       <!-- Test Comment -->
       <child attr2="val2" attr3="val3">
          <nested/>
       </child>
    </root>`;

    const parsed = parseXmlPure(rawXml);
    assert.ok(parsed.root);
    assert.equal(parsed.root.name, 'root');
    assert.equal(parsed.root.attributes.attr1, 'val1');

    // Check stats
    assert.equal(parsed.stats.elementCount, 3); // root, child, nested
    assert.equal(parsed.stats.attributeCount, 3); // attr1, attr2, attr3
    assert.equal(parsed.stats.commentCount, 1);
  });

  await t.test('parseXmlPure should identify unclosed/malformed tags with exact errors', () => {
    const malformed = `<root>\n  <child>\n</root>`; // Missing </child> or extra </root>
    assert.throws(() => parseXmlPure(malformed), /Mismatched closing tag/);

    const unclosed = `<root><unclosed>`;
    assert.throws(() => parseXmlPure(unclosed), /Unclosed XML tag/);
  });

  await t.test('parseXmlPure should handle namespaces, attributes and preserve raw contents', () => {
    const namespacesXml = `<pcf:PCF xmlns:pcf="http://guidewire.com/pcf">\n  <pcf:Card id="MainCard" />\n</pcf:PCF>`;
    const parsed = parseXmlPure(namespacesXml);

    assert.equal(parsed.root.name, 'pcf:PCF');
    assert.equal(parsed.root.attributes['xmlns:pcf'], 'http://guidewire.com/pcf');
    assert.equal(parsed.root.children[0].name, 'pcf:Card');
    assert.equal(parsed.root.children[0].attributes.id, 'MainCard');
  });
});

test('PCF / XML Path Explorer - XPath Generation', async (t) => {

  await t.test('parseXmlPure should construct accurate XPaths including sibling indices', () => {
    const nestedXml = `<PCF>
      <Card>
         <CardView id="V1"/>
         <CardView id="V2"/>
      </Card>
    </PCF>`;

    const parsed = parseXmlPure(nestedXml);
    const card = parsed.root.children[0];
    const cardView1 = card.children[0];
    const cardView2 = card.children[1];

    assert.equal(parsed.root.xpath, '/PCF');
    assert.equal(card.xpath, '/PCF/Card');
    assert.equal(cardView1.xpath, '/PCF/Card/CardView');
    assert.equal(cardView2.xpath, '/PCF/Card/CardView[2]');
  });
});

test('PCF / XML Path Explorer - Search & Formatting', async (t) => {

  await t.test('searchNodes should retrieve matching elements by tag name or attribute values', () => {
    const searchXml = `<root>
      <element id="E1" type="Card" />
      <element id="E2" type="Detail" />
      <other id="E3" />
    </root>`;

    const parsed = parseXmlPure(searchXml);
    
    // Search tag name
    const matchTag = searchNodes(parsed.root, 'other');
    assert.equal(matchTag.length, 1);
    assert.equal(matchTag[0].name, 'other');

    // Search attribute value
    const matchAttr = searchNodes(parsed.root, 'Card');
    assert.equal(matchAttr.length, 1);
    assert.equal(matchAttr[0].attributes.id, 'E1');
  });

  await t.test('formatXmlPCF should pretty print XML without altering comments or attributes', () => {
    const rawXml = `<?xml version="1.0"?><PCF><!-- Comment --><Card id="1"     type="test"  ></Card></PCF>`;
    const formatted = formatXmlPCF(rawXml);

    const expected = `<?xml version="1.0"?>\n<!-- Comment -->\n<Card id="1"     type="test"  >\n</Card>\n</PCF>`;
    // Original attributes spacing and comments are perfectly preserved
    assert.ok(formatted.includes('<!-- Comment -->'));
    assert.ok(formatted.includes('id="1"     type="test"'));
  });

  await t.test('parseXmlPure should handle empty or invalid inputs gracefully', () => {
    assert.throws(() => parseXmlPure(''), /Empty or invalid/);
    assert.throws(() => parseXmlPure('   '), /Empty or invalid/);
  });
});
