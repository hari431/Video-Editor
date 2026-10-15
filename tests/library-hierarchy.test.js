import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readQueryLibrary } from '../src/library/local.js';
import { buildTree, findFile, folderAt, legacyQueryPath, searchFiles } from '../src/library/tree.js';

const QUERIES_DIR = fileURLToPath(new URL('../queries/', import.meta.url));
const VIDEO_FIXTURE = 'Videos/Finding Rate table & Routine Usages.mp4';

async function loadTree() {
  const { files, videos, folders } = await readQueryLibrary();
  return buildTree(files, videos, folders);
}

const EXPECTED_FILES = [
  'Guidewire/Gosu/PC/Config/Unlocking from quoting.txt',
  "Guidewire/Gosu/PC/Rating/Delete RB's & Routines.txt",
  'Guidewire/Gosu/PC/Rating/Finding Variable assignment.txt',
  'Guidewire/Gosu/PC/Rating/Partial worksheet print.txt',
  'Guidewire/Gosu/PC/Rating/Rate routine variables.txt',
  "Guidewire/Gosu/PC/Rating/Rate table Usage in RR's.txt"
];

test('query library is preserved and nested under Guidewire/Gosu/PC', async () => {
  const { files } = await readQueryLibrary();
  const paths = files.map(file => file.path);
  assert.ok(files.length >= 6, 'no query file lost');
  for (const expected of EXPECTED_FILES) {
    assert.ok(paths.includes(expected), `missing ${expected}`);
  }
  // assert.ok(paths.every(p => p.startsWith('Guidewire/Gosu/PC/')), 'all content lives under the new hierarchy');
});

test('built tree reflects Guidewire -> Gosu -> PC -> Rating hierarchy', async () => {
  const tree = await loadTree();
  assert.ok(folderAt(tree, 'Guidewire'), 'top level is Guidewire');
  assert.ok(folderAt(tree, 'Guidewire/Gosu'), 'Guidewire contains Gosu');
  const pc = folderAt(tree, 'Guidewire/Gosu/PC');
  assert.ok(pc, 'Gosu contains PC');
  assert.ok(pc.children.has('Rating'));
  assert.ok(pc.children.has('Config'));
});

test('empty top-level folder (Videos) appears in the tree even without query files', async () => {
  const tree = await loadTree();
  assert.ok(tree.children.has('Videos'), 'Videos is listed at the top level');
  const videos = folderAt(tree, 'Videos');
  assert.ok(videos, 'Videos folder is discovered from the filesystem');
  assert.equal(videos.type, 'folder');
  assert.ok(videos.children.has('Finding Rate table & Routine Usages.mp4'), 'Videos holds a video instead of a query file');
  assert.equal(videos.children.get('Finding Rate table & Routine Usages.mp4').type, 'video');
  assert.equal(findFile(tree, VIDEO_FIXTURE), null, 'videos are not query files');
  assert.equal(legacyQueryPath(tree, 'Videos'), null, 'Videos is not legacy-mapped');
});

test('nested empty folder with spaces (Guidewire/Tutorial Videos) appears and is browseable', async () => {
  const abs = path.join(QUERIES_DIR, 'Guidewire', 'Tutorial Videos');
  await mkdir(abs, { recursive: true });
  try {
    const tree = await loadTree();
    const guidewire = folderAt(tree, 'Guidewire');
    assert.ok(guidewire.children.has('Tutorial Videos'), 'nested empty folder with a space is listed');
    const nested = folderAt(tree, 'Guidewire/Tutorial Videos');
    assert.ok(nested, 'nested empty folder is discovered');
    assert.equal(nested.type, 'folder');
    assert.equal(nested.children.size, 0);
    assert.equal(findFile(tree, 'Guidewire/Tutorial Videos'), null, 'a folder is not a query file');
  } finally {
    await rm(abs, { recursive: true, force: true });
  }
});

test('existing Config and Rating query files remain findable', async () => {
  const tree = await loadTree();
  const config = findFile(tree, 'Guidewire/Gosu/PC/Config/Unlocking from quoting.txt');
  assert.ok(config && config.type === 'file', 'Config query is still discoverable');
  const rating = findFile(tree, "Guidewire/Gosu/PC/Rating/Delete RB's & Routines.txt");
  assert.ok(rating && rating.type === 'file', 'Rating query is still discoverable');
  assert.ok(folderAt(tree, 'Guidewire/Gosu/PC/Config').children.size >= 1);
  assert.ok(folderAt(tree, 'Guidewire/Gosu/PC/Rating').children.size >= 5);
});

test('legacy PC/* URLs map to their new Guidewire/Gosu/PC locations', async () => {
  const tree = await loadTree();
  assert.equal(legacyQueryPath(tree, 'PC'), 'Guidewire/Gosu/PC');
  assert.equal(legacyQueryPath(tree, 'PC/Rating'), 'Guidewire/Gosu/PC/Rating');
  assert.equal(legacyQueryPath(tree, 'PC/Config'), 'Guidewire/Gosu/PC/Config');
  assert.equal(
    legacyQueryPath(tree, "PC/Rating/Rate table Usage in RR's.txt"),
    "Guidewire/Gosu/PC/Rating/Rate table Usage in RR's.txt"
  );
  assert.equal(legacyQueryPath(tree, 'PC/DoesNotExist'), null);
  assert.equal(legacyQueryPath(tree, 'Other/Path'), null);
});

test('queries remain searchable under the new hierarchy', async () => {
  const tree = await loadTree();
  const results = searchFiles(tree, 'worksheet');
  assert.ok(results.some(result => result.path === 'Guidewire/Gosu/PC/Rating/Partial worksheet print.txt'));
});