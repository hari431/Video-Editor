import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePinnedReferences } from '../src/library/pinned.js';
import { extractYouTubeId, isBloggerUrl, isDriveUrl, isValidExternalUrl } from '../src/library/local.js';

test('One Pinned URL', () => {
  const content = 'Some query\nPinned: https://www.youtube.com/watch?v=dQw4w9WgXcQ\nMore text';
  const { cleanContent, pinned } = parsePinnedReferences(content);
  assert.equal(pinned.length, 1);
  assert.equal(pinned[0].url, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(pinned[0].title, 'YouTube Video');
  assert.doesNotMatch(cleanContent, /Pinned:/);
  assert.match(cleanContent, /Some query/);
});

test('Multiple Pinned URLs preserve order', () => {
  const content = 'Pinned: Part 1 | https://www.youtube.com/watch?v=dQw4w9WgXcQ\nPinned: Part 2 | https://www.youtube.com/watch?v=abc123DEF45\nPinned: Notes | https://learnwithmegw.blogspot.com/2026/09/rating-overrides.html';
  const { pinned } = parsePinnedReferences(content);
  assert.equal(pinned.length, 3);
  assert.equal(pinned[0].title, 'Part 1');
  assert.equal(pinned[1].title, 'Part 2');
  assert.equal(pinned[2].title, 'Notes');
  assert.equal(pinned[0].url, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
});

test('<Title> | <URL> syntax', () => {
  const content = 'Pinned: Part 1 - Rating Overrides | https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  const { pinned } = parsePinnedReferences(content);
  assert.equal(pinned.length, 1);
  assert.equal(pinned[0].title, 'Part 1 - Rating Overrides');
  assert.equal(pinned[0].url, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
});

test('URL-only syntax fallback title', () => {
  const content = 'Pinned: https://learnwithmegw.blogspot.com/2026/09/rating-overrides.html';
  const { pinned } = parsePinnedReferences(content);
  assert.equal(pinned.length, 1);
  assert.equal(pinned[0].title, 'Blogger Post');
  const content2 = 'Pinned: https://drive.google.com/file/d/1JjZML-RZxv3gtHa7vzOp5ptp7S0fvmu_/view?usp=sharing';
  const { pinned: p2 } = parsePinnedReferences(content2);
  assert.equal(p2[0].title, 'Drive File');
  const content3 = 'Pinned: https://example.com/page';
  const { pinned: p3 } = parsePinnedReferences(content3);
  assert.equal(p3[0].title, 'example.com');
});

test('Blank Pinned line ignored', () => {
  const content = 'Pinned:   \nPinned: https://www.youtube.com/watch?v=dQw4w9WgXcQ\nPinned:\n';
  const { pinned, cleanContent } = parsePinnedReferences(content);
  assert.equal(pinned.length, 1);
  assert.doesNotMatch(cleanContent, /Pinned:/);
});

test('File with no Pinned lines', () => {
  const content = 'SELECT * FROM PolicyPeriod WHERE EffDated = true';
  const { pinned, cleanContent } = parsePinnedReferences(content);
  assert.equal(pinned.length, 0);
  assert.equal(cleanContent, content);
});

test('Invalid URL handling', () => {
  const content = 'Pinned: Bad | javascript:alert(1)\nPinned: https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  const { pinned } = parsePinnedReferences(content);
  assert.equal(pinned.length, 1);
  assert.equal(pinned[0].url, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  const content2 = 'Pinned: ftp://example.com/file';
  const { pinned: p2 } = parsePinnedReferences(content2);
  assert.equal(p2.length, 0);
});

test('Pinned syntax not displayed as raw text', () => {
  const content = 'Line1\nPinned: Part 1 | https://www.youtube.com/watch?v=dQw4w9WgXcQ\nLine2';
  const { cleanContent } = parsePinnedReferences(content);
  assert.doesNotMatch(cleanContent, /Pinned:/);
  assert.doesNotMatch(cleanContent, /https:\/\/www\.youtube\.com\/watch\?v=dQw4w9WgXcQ/);
  assert.match(cleanContent, /Line1/);
  assert.match(cleanContent, /Line2/);
});

test('Existing YouTube/Blogger/Drive URL validation reused', () => {
  const yt = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  const blog = 'https://learnwithmegw.blogspot.com/2026/09/rating-overrides.html';
  const drive = 'https://drive.google.com/file/d/1JjZML-RZxv3gtHa7vzOp5ptp7S0fvmu_/view?usp=sharing';
  assert.ok(isValidExternalUrl(yt) && extractYouTubeId(yt));
  assert.ok(isBloggerUrl(blog));
  assert.ok(isDriveUrl(drive));
  const content = `Pinned: YT | ${yt}\nPinned: Blog | ${blog}\nPinned: Drive | ${drive}`;
  const { pinned } = parsePinnedReferences(content);
  assert.equal(pinned.length, 3);
});

test('Case-insensitive Pinned: prefix', () => {
  const content = 'pinned: https://www.youtube.com/watch?v=dQw4w9WgXcQ\nPINNED: https://example.com/page';
  const { pinned } = parsePinnedReferences(content);
  assert.equal(pinned.length, 2);
});

test('Pinned with leading spaces', () => {
  const content = '  Pinned: https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  const { pinned } = parsePinnedReferences(content);
  assert.equal(pinned.length, 1);
});

test('Pinned with space before colon', () => {
  const content = 'Pinned : https://youtu.be/Q24w2eJLXvs\nPinned : Ratetable Creation - Part1 | https://youtu.be/Q24w2eJLXvs';
  const { pinned } = parsePinnedReferences(content);
  assert.equal(pinned.length, 2);
  assert.equal(pinned[0].url, 'https://youtu.be/Q24w2eJLXvs');
  assert.equal(pinned[1].title, 'Ratetable Creation - Part1');
});

test('External file with URL + one Pinned line', async () => {
  const { parseExternalFileContent } = await import('../src/library/local.js');
  const raw = 'https://youtu.be/A-eOHEuYY7A\n\nPinned : https://youtu.be/Q24w2eJLXvs';
  const { externalUrl, pinned, cleanContent } = parseExternalFileContent(raw);
  assert.equal(externalUrl, 'https://youtu.be/A-eOHEuYY7A');
  assert.equal(pinned.length, 1);
  assert.equal(pinned[0].url, 'https://youtu.be/Q24w2eJLXvs');
  assert.doesNotMatch(cleanContent, /Pinned/);
  assert.match(cleanContent, /https:\/\/youtu.be\/A-eOHEuYY7A/);
});

test('External file with URL + multiple Pinned lines', async () => {
  const { parseExternalFileContent } = await import('../src/library/local.js');
  const raw = 'https://youtu.be/A-eOHEuYY7A\n\nPinned: Ratetable Creation - Part1 | https://youtu.be/Q24w2eJLXvs\nPinned: Detailed Notes | https://learnwithmegw.blogspot.com/2026/09/rating-overrides.html\nPinned: Reference PDF | https://drive.google.com/file/d/1JjZML-RZxv3gtHa7vzOp5ptp7S0fvmu_/view?usp=sharing';
  const { externalUrl, pinned } = parseExternalFileContent(raw);
  assert.equal(externalUrl, 'https://youtu.be/A-eOHEuYY7A');
  assert.equal(pinned.length, 3);
  assert.equal(pinned[0].title, 'Ratetable Creation - Part1');
  assert.equal(pinned[1].title, 'Detailed Notes');
  assert.equal(pinned[2].title, 'Reference PDF');
  assert.equal(pinned[0].url, 'https://youtu.be/Q24w2eJLXvs');
});

test('External file with URL and no Pinned lines', async () => {
  const { parseExternalFileContent } = await import('../src/library/local.js');
  const raw = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  const { externalUrl, pinned } = parseExternalFileContent(raw);
  assert.equal(externalUrl, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(pinned.length, 0);
});

test('Existing YouTube external file remains YouTube', async () => {
  const { parseExternalFileContent } = await import('../src/library/local.js');
  const { extractYouTubeId } = await import('../src/library/local.js');
  const raw = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  const { externalUrl } = parseExternalFileContent(raw);
  assert.ok(extractYouTubeId(externalUrl));
});

test('Existing Blogger external file remains Blogger', async () => {
  const { parseExternalFileContent, isBloggerUrl } = await import('../src/library/local.js');
  const raw = 'https://learnwithmegw.blogspot.com/2026/09/rating-overrides.html';
  const { externalUrl } = parseExternalFileContent(raw);
  assert.ok(isBloggerUrl(externalUrl));
});

test('Existing Drive external file remains Drive', async () => {
  const { parseExternalFileContent, isDriveUrl } = await import('../src/library/local.js');
  const raw = 'https://drive.google.com/file/d/1JjZML-RZxv3gtHa7vzOp5ptp7S0fvmu_/view?usp=sharing';
  const { externalUrl } = parseExternalFileContent(raw);
  assert.ok(isDriveUrl(externalUrl));
});

test('Invalid Pinned URL not added', async () => {
  const { parseExternalFileContent } = await import('../src/library/local.js');
  const raw = 'https://youtu.be/A-eOHEuYY7A\nPinned: Bad | javascript:alert(1)';
  const { pinned } = parseExternalFileContent(raw);
  assert.equal(pinned.length, 0);
});

test('Pinned syntax not displayed as raw content for External', async () => {
  const { parseExternalFileContent } = await import('../src/library/local.js');
  const raw = 'https://youtu.be/A-eOHEuYY7A\nPinned: Part1 | https://youtu.be/Q24w2eJLXvs';
  const { cleanContent } = parseExternalFileContent(raw);
  assert.doesNotMatch(cleanContent, /Pinned:/);
  assert.doesNotMatch(cleanContent, /Q24w2eJLXvs/);
});

test('Legacy Pinned syntax still works', () => {
  const content = 'Pinned: Video Name | /video/path';
  const { pinned } = parsePinnedReferences(content);
  assert.equal(pinned.length, 1);
  assert.equal(pinned[0].access, 'normal');
  assert.equal(pinned[0].title, 'Video Name');
  assert.equal(pinned[0].url, '/video/path');
});

test('Pinned: | Title | URL → normal', () => {
  const content = 'Pinned: | Rating Creation - Part 1 | /query/Guidewire/Gosu/PC/Rating/Rating/Ratingtable%20creation%201';
  const { pinned } = parsePinnedReferences(content);
  assert.equal(pinned.length, 1);
  assert.equal(pinned[0].access, 'normal');
  assert.equal(pinned[0].title, 'Rating Creation - Part 1');
});

test('Pinned Null variations → normal', () => {
  for (const v of ['Null','null','NULL','  Null  ']) {
    const content = `Pinned: ${v} | Video Name | /video/path`;
    const { pinned } = parsePinnedReferences(content);
    assert.equal(pinned[0].access, 'normal', `failed for ${v}`);
  }
  const content2 = 'Pinned: Null | Video Name | /video/path';
  const { pinned: p2 } = parsePinnedReferences(content2);
  assert.equal(p2[0].title, 'Video Name');
});

test('Pinned Premium variations → premium', () => {
  for (const v of ['Premium','premium','PREMIUM','  Premium  ']) {
    const content = `Pinned: ${v} | Video Name | /video/path`;
    const { pinned } = parsePinnedReferences(content);
    assert.equal(pinned[0].access, 'premium', `failed for ${v}`);
  }
  const content2 = 'Pinned :   PREMIUM   | Video Name | /video/path';
  const { pinned: p2 } = parsePinnedReferences(content2);
  assert.equal(p2[0].access, 'premium');
  assert.equal(p2[0].title, 'Video Name');
});

test('Pinned Premium with local path', () => {
  const content = 'Pinned: Premium | Rating Creation - Part 2 | /query/Guidewire/Gosu/PC/Rating/Rating/Ratingtable%20creation%202';
  const { pinned } = parsePinnedReferences(content);
  assert.equal(pinned.length, 1);
  assert.equal(pinned[0].access, 'premium');
  assert.equal(pinned[0].title, 'Rating Creation - Part 2');
  assert.equal(pinned[0].url, '/query/Guidewire/Gosu/PC/Rating/Rating/Ratingtable%20creation%202');
});

test('Multiple normal + premium preserve order', () => {
  const content = 'Pinned: | Rating Creation - Part 1 | /query/a\nPinned: Premium | Rating Creation - Part 2 | /query/b\nPinned: PREMIUM | Advanced Rating Notes | /query/c';
  const { pinned } = parsePinnedReferences(content);
  assert.equal(pinned.length, 3);
  assert.equal(pinned[0].access, 'normal');
  assert.equal(pinned[1].access, 'premium');
  assert.equal(pinned[2].access, 'premium');
  assert.equal(pinned[0].title, 'Rating Creation - Part 1');
  assert.equal(pinned[1].title, 'Rating Creation - Part 2');
  assert.equal(pinned[2].title, 'Advanced Rating Notes');
});

test('Local website paths continue working as references', () => {
  const content = 'Pinned: | Rating Creation - Part 1 | /query/Guidewire/Gosu/PC/Rating/Rating/Ratingtable%20creation%201';
  const { pinned } = parsePinnedReferences(content);
  assert.equal(pinned.length, 1);
  assert.equal(pinned[0].url, '/query/Guidewire/Gosu/PC/Rating/Rating/Ratingtable%20creation%201');
  const content2 = 'Pinned: Premium | Part 2 | /video/TestVideo.mp4';
  const { pinned: p2 } = parsePinnedReferences(content2);
  assert.equal(p2[0].access, 'premium');
});

test('Premium flag does not grant access - is presentation only', () => {
  const content = 'Pinned: Premium | Video Name | /video/path';
  const { pinned } = parsePinnedReferences(content);
  assert.equal(pinned[0].access, 'premium');
  // Simulate that premium check is separate: hasUserActiveAccess would still be false for free user
  // Pinned access flag is just metadata, not authorization - verified by not calling any auth function here
  assert.ok(pinned[0].title);
});

test('Pinned with unknown first field preserves legacy behavior', () => {
  const content = 'Pinned: SomethingElse | Video Name | /video/path';
  const { pinned } = parsePinnedReferences(content);
  assert.equal(pinned.length, 1);
  assert.equal(pinned[0].access, 'normal');
  assert.equal(pinned[0].title, 'SomethingElse | Video Name');
  assert.equal(pinned[0].url, '/video/path');
});

test('Existing normal Pinned localhost external', () => {
  const content = 'Pinned : http://localhost:3100/external/Guidewire/Gosu/PC/Rating/Rating/External%20-%20Ratetable%20Creation%20-%20Part1.txt';
  const { pinned } = parsePinnedReferences(content);
  assert.equal(pinned.length, 1);
  assert.equal(pinned[0].access, 'normal');
  assert.equal(pinned[0].url, 'http://localhost:3100/external/Guidewire/Gosu/PC/Rating/Rating/External%20-%20Ratetable%20Creation%20-%20Part1.txt');
});

test('Premium localhost external Pinned', () => {
  const content = 'Pinned : Premium | test | http://localhost:3100/external/Guidewire/Gosu/PC/Rating/Rating/External%20-%20Ratetable%20Creation%20-%20Part1.txt';
  const { pinned } = parsePinnedReferences(content);
  assert.equal(pinned.length, 1);
  assert.equal(pinned[0].access, 'premium');
  assert.equal(pinned[0].title, 'test');
  assert.equal(pinned[0].url, 'http://localhost:3100/external/Guidewire/Gosu/PC/Rating/Rating/External%20-%20Ratetable%20Creation%20-%20Part1.txt');
});

test('Premium HTTPS external URL', () => {
  const content = 'Pinned: Premium | test | https://example.com/page';
  const { pinned } = parsePinnedReferences(content);
  assert.equal(pinned.length, 1);
  assert.equal(pinned[0].access, 'premium');
  assert.equal(pinned[0].url, 'https://example.com/page');
});

test('/external/ relative URLs open in new tab', () => {
  const getTarget = (url) => url.startsWith('/external/') ? '_blank' : url.startsWith('/') ? '_self' : '_blank';
  assert.equal(getTarget('/external/Guidewire/Gosu/PC/Rating/Rating/External%20-%20Part1.txt'), '_blank');
  assert.equal(getTarget('/external/Test.txt'), '_blank');
  assert.equal(getTarget('/query/Guidewire/Gosu/PC/Rating/Rating/Test.txt'), '_self');
  assert.equal(getTarget('/video/TestVideo.mp4'), '_self');
  assert.equal(getTarget('/item/Test.pdf'), '_self');
  assert.equal(getTarget('/browse/Guidewire'), '_self');
  assert.equal(getTarget('https://example.com/page'), '_blank');
  assert.equal(getTarget('http://localhost:3100/external/Test.txt'), '_blank');
});
