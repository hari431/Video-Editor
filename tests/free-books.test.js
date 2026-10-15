import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FREE_TECHNICAL_BOOKS,
  FREE_TECHNICAL_BOOK_CATEGORIES,
  getFreeTechnicalBooks
} from '../src/free-books/data.js';

test('free technical books catalog has hostable and link-only resources', () => {
  assert.ok(FREE_TECHNICAL_BOOKS.length >= 10);
  assert.ok(FREE_TECHNICAL_BOOKS.some(item => item.kind === 'host'));
  assert.ok(FREE_TECHNICAL_BOOKS.some(item => item.kind === 'link'));
});

test('catalog entries include source and licence metadata', () => {
  for (const item of FREE_TECHNICAL_BOOKS) {
    assert.ok(item.title);
    assert.ok(item.category);
    assert.ok(item.author);
    assert.ok(item.sourceUrl);
    assert.ok(item.licence);
    assert.ok(item.licenceUrl);
    assert.ok(['host', 'link'].includes(item.kind));
  }
});

test('catalog filtering is deterministic', () => {
  const security = getFreeTechnicalBooks({ category: 'Security' });
  assert.ok(security.length >= 2);
  assert.ok(security.every(item => item.category === 'Security'));

  const links = getFreeTechnicalBooks({ kind: 'link' });
  assert.ok(links.length >= 3);
  assert.ok(links.every(item => item.kind === 'link'));

  assert.ok(FREE_TECHNICAL_BOOK_CATEGORIES.includes('AWS / Cloud'));
});


test('hosted reader URLs are restricted to verified open-book sources', () => {
  const readable = FREE_TECHNICAL_BOOKS.filter(item => item.readUrl);
  assert.ok(readable.length >= 3);
  for (const item of readable) {
    assert.equal(item.kind, 'host');
    assert.ok(item.slug);
    assert.ok(/^https:\/\//.test(item.readUrl));
  }
});
