import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePinnedReferences, stripPinnedParagraphsFromHtml } from '../src/library/pinned.js';

test('pipe form: Pinned | Premium | Title | URL', () => {
  const { pinned } = parsePinnedReferences('Pinned | Premium | Video Name | /video/path');
  assert.equal(pinned.length, 1);
  assert.equal(pinned[0].access, 'premium');
  assert.equal(pinned[0].title, 'Video Name');
  assert.equal(pinned[0].url, '/video/path');
});

test('pipe form: Pinned | Title | URL → normal', () => {
  const { pinned } = parsePinnedReferences('Pinned | Part 1 - Rating Overrides | https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(pinned.length, 1);
  assert.equal(pinned[0].access, 'normal');
  assert.equal(pinned[0].title, 'Part 1 - Rating Overrides');
});

test('pipe form: Pinned | URL → normal with fallback title', () => {
  const { pinned } = parsePinnedReferences('Pinned | https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(pinned.length, 1);
  assert.equal(pinned[0].access, 'normal');
  assert.equal(pinned[0].title, 'YouTube Video');
});

test('pipe form equals colon form for the reported example', () => {
  const pipe = 'Pinned | Premium | Reading data from Excel | /external/Premium/Rating/Tutorial.txt';
  const colon = 'Pinned: Premium | Reading data from Excel | /external/Premium/Rating/Tutorial.txt';
  const a = parsePinnedReferences(pipe).pinned;
  const b = parsePinnedReferences(colon).pinned;
  assert.equal(a.length, 1);
  assert.deepEqual(a, b);
});

test('pipe form: case-insensitive, leading spaces, no space after Pinned', () => {
  for (const line of [
    'pinned | https://example.com/a',
    'PINNED | https://example.com/a',
    '  Pinned | https://example.com/a',
    'Pinned| https://example.com/a',
    'Pinned |https://example.com/a',
  ]) {
    const { pinned } = parsePinnedReferences(line);
    assert.equal(pinned.length, 1, line);
    assert.equal(pinned[0].url, 'https://example.com/a', line);
  }
});

test('pipe form: Null/blank access → normal', () => {
  for (const line of [
    'Pinned | Null | Video Name | /video/path',
    'Pinned | | Video Name | /video/path',
  ]) {
    const { pinned } = parsePinnedReferences(line);
    assert.equal(pinned.length, 1, line);
    assert.equal(pinned[0].access, 'normal', line);
    assert.equal(pinned[0].title, 'Video Name', line);
  }
});

test('pipe form: unknown first field preserves legacy title join', () => {
  const { pinned } = parsePinnedReferences('Pinned | SomethingElse | Video Name | /video/path');
  assert.equal(pinned.length, 1);
  assert.equal(pinned[0].access, 'normal');
  assert.equal(pinned[0].title, 'SomethingElse | Video Name');
});

test('pipe form: invalid URL skipped', () => {
  const { pinned } = parsePinnedReferences('Pinned | Bad | javascript:alert(1)');
  assert.equal(pinned.length, 0);
});

test('pipe form: blank line ignored and stripped from content', () => {
  const { pinned, cleanContent } = parsePinnedReferences('Line1\nPinned |\nLine2');
  assert.equal(pinned.length, 0);
  assert.doesNotMatch(cleanContent, /Pinned/);
  assert.match(cleanContent, /Line1/);
});

test('pipe form: stripped from displayed content like colon form', () => {
  const { cleanContent } = parsePinnedReferences('Line1\nPinned | Notes | https://example.com/x\nLine2');
  assert.doesNotMatch(cleanContent, /Pinned/);
  assert.doesNotMatch(cleanContent, /example\.com\/x/);
  assert.match(cleanContent, /Line1/);
});

test('pipe form: mixed colon + pipe lines preserve order', () => {
  const { pinned } = parsePinnedReferences(
    'Pinned: First | https://example.com/1\nPinned | Second | https://example.com/2\nPinned: Premium | Third | https://example.com/3'
  );
  assert.deepEqual(pinned.map(p => p.title), ['First', 'Second', 'Third']);
  assert.equal(pinned[2].access, 'premium');
});

test('bare "Pinned" without separator stays normal content', () => {
  const { pinned, cleanContent } = parsePinnedReferences('Pinned\nPinned stars are nice');
  assert.equal(pinned.length, 0);
  assert.match(cleanContent, /Pinned/);
});

test('colon form behavior unchanged (spot check)', () => {
  const { pinned } = parsePinnedReferences('Pinned: Premium | Video Name | /video/path');
  assert.deepEqual(pinned, [{ title: 'Video Name', url: '/video/path', access: 'premium' }]);
});

test('preview strip handles pipe-form paragraphs', () => {
  const html = '<p>Body</p><p>Pinned | Notes | https://example.com/x</p><p>Pinned: Old | https://example.com/y</p>';
  const out = stripPinnedParagraphsFromHtml(html);
  assert.match(out, /Body/);
  assert.doesNotMatch(out, /Pinned/);
});
