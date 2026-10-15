import { test } from 'node:test';
import assert from 'node:assert/strict';
import ejs from 'ejs';
import fs from 'node:fs';

const template = fs.readFileSync('src/views/query.ejs', 'utf-8');

function renderQuery(path) {
  return ejs.render(template, {
    file: { path, content: 'test content' },
    path,
    categoryForPath: (p) => {
      const parts = p.split('/').filter(Boolean);
      return parts.length > 1 ? parts.slice(0, -1).join(' / ') : 'Uncategorized';
    },
    displayName: (n) => n,
    user: { name: 'Test', email: 'test@example.com' },
    canCopy: true,
    likeCount: 0,
    liked: false,
    showAd: false,
    discussions: [],
    hasNotes: false
  }, { filename: 'src/views/query.ejs' });
}

test('Interview Questions Viewer UI (now Text File Viewer UI)', async (t) => {
  await t.test('Applies sticky-query-head and interview-question-code to all .txt files', () => {
    const html1 = renderQuery('queries/Interview Questions/Question 1.txt');
    assert.match(html1, /sticky-query-head/);
    assert.match(html1, /interview-question-code/);

    const html2 = renderQuery('queries/Other/example.txt');
    assert.match(html2, /sticky-query-head/);
    assert.match(html2, /interview-question-code/);
  });

  await t.test('Does NOT apply classes to non-text code queries', () => {
    const html = renderQuery('queries/Other/example.java');
    
    assert.doesNotMatch(html, /sticky-query-head/);
    assert.doesNotMatch(html, /interview-question-code/);
  });
});
