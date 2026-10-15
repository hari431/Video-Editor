import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  isCompanionMetadataFilename,
  companionPathForItem,
  companionTargetCandidates,
  isHiddenCompanionPath,
  isHiddenCompanionOnDisk,
} from '../src/library/local.js';
import {
  parsePinnedReferences,
  dedupePinnedRefs,
  stripPinnedParagraphsFromHtml,
  getPinnedForItemWithRoot,
  getPinnedForItem,
  _clearPinV1Cache,
} from '../src/library/pinned.js';

test('companion filename detection', () => {
  assert.equal(isCompanionMetadataFilename('Report_1.txt'), true);
  assert.equal(isCompanionMetadataFilename('Report_1.TXT'), true);
  assert.equal(isCompanionMetadataFilename('Report.txt'), false);
  assert.equal(isCompanionMetadataFilename('Report.pdf'), false);
  assert.equal(isCompanionMetadataFilename('External - Report_1.txt'), false);
  assert.equal(isCompanionMetadataFilename('External - Foo.txt'), false);
});

test('companionPathForItem mapping', () => {
  assert.equal(companionPathForItem('A/B/Report.pdf'), 'A/B/Report_1.txt');
  assert.equal(companionPathForItem('A/B/Data.xlsx'), 'A/B/Data_1.txt');
  assert.equal(companionPathForItem('A/B/Doc.docx'), 'A/B/Doc_1.txt');
  assert.equal(companionPathForItem('Report.pdf'), 'Report_1.txt');
  assert.equal(companionPathForItem('A/B/Report_1.txt'), null);
  assert.equal(companionPathForItem('A/B/External - Foo.txt'), null);
  assert.equal(companionPathForItem('A/B/noext'), null);
});

test('companionTargetCandidates reverse mapping', () => {
  // v2 generalized: candidates now cover every companionable registry
  // extension (pdf/docx/xlsx still included, order still registry-stable).
  const cands = companionTargetCandidates('A/B/Report_1.txt');
  for (const ext of ['.pdf', '.xlsx', '.docx', '.pptx', '.png', '.zip', '.doc', '.xls', '.ppt']) {
    assert.ok(cands.includes(`A/B/Report${ext}`), `missing candidate ${ext}`);
  }
  assert.ok(!cands.some(c => c.endsWith('.txt') || c.endsWith('.md') || c.endsWith('.mp4')));
  assert.equal(cands[0], 'A/B/Report.pdf');
  assert.deepEqual(companionTargetCandidates('A/B/Report.txt'), []);
  assert.deepEqual(companionTargetCandidates('A/B/External - Foo_1.txt'), []);
});

test('isHiddenCompanionPath requires existing target in set', () => {
  const withTarget = new Set(['a/b/report.pdf']);
  const withoutTarget = new Set(['a/b/other.pdf']);
  assert.equal(isHiddenCompanionPath('A/B/Report_1.txt', withTarget), true);
  assert.equal(isHiddenCompanionPath('A/B/Report_1.txt', withoutTarget), false);
  assert.equal(isHiddenCompanionPath('A/B/Report_1.txt', new Set()), false);
});

test('canonical parser reused for sidecar content', () => {
  const { pinned } = parsePinnedReferences(
    'Pinned: Premium | Part 2 | /query/a\nPinned: Notes | https://example.com/x'
  );
  assert.equal(pinned.length, 2);
  assert.equal(pinned[0].access, 'premium');
});

test('dedupePinnedRefs removes exact duplicates and caps', () => {
  const dup = { title: 'A', url: 'https://example.com', access: 'normal' };
  assert.equal(dedupePinnedRefs([dup, { ...dup }]).length, 1);
  const many = Array.from({ length: 60 }, (_, i) => ({ title: `T${i}`, url: `https://example.com/${i}`, access: 'normal' }));
  assert.equal(dedupePinnedRefs(many).length, 50);
});

test('stripPinnedParagraphsFromHtml removes pin paragraphs only', () => {
  const html = '<p>Hello</p><p>Pinned: Notes | https://example.com/x</p><p>World</p>';
  const out = stripPinnedParagraphsFromHtml(html);
  assert.match(out, /Hello/);
  assert.match(out, /World/);
  assert.doesNotMatch(out, /Pinned:/);
  assert.doesNotMatch(out, /example\.com\/x/);
});

test('getPinnedForItem: pdf sidecar via temp root', async () => {
  _clearPinV1Cache();
  const root = mkdtempSync(join(tmpdir(), 'pins-v1-'));
  try {
    mkdirSync(join(root, 'A', 'B'), { recursive: true });
    writeFileSync(join(root, 'A', 'B', 'Report.pdf'), '%PDF-1.4 fake');
    writeFileSync(
      join(root, 'A', 'B', 'Report_1.txt'),
      'Pinned: Premium | Part 2 | /query/a\nPinned: Notes | https://example.com/x\n'
    );
    const pinned = await getPinnedForItemWithRoot('A/B/Report.pdf', root);
    assert.equal(pinned.length, 2);
    assert.equal(pinned[0].access, 'premium');
    assert.equal(pinned[0].title, 'Part 2');
    // companion itself never yields pins
    assert.deepEqual(await getPinnedForItemWithRoot('A/B/Report_1.txt', root), []);
    // hidden-on-disk check needs real queries/ root, so assert mapping only here
    assert.equal(companionPathForItem('A/B/Report.pdf'), 'A/B/Report_1.txt');
  } finally {
    rmSync(root, { recursive: true, force: true });
    _clearPinV1Cache();
  }
});

test('getPinnedForItem: xlsx sidecar via temp root', async () => {
  _clearPinV1Cache();
  const root = mkdtempSync(join(tmpdir(), 'pins-v1-'));
  try {
    writeFileSync(join(root, 'Data.xlsx'), 'fake-xlsx');
    writeFileSync(join(root, 'Data_1.txt'), 'Pinned: Sheet notes | https://example.com/s\n');
    const pinned = await getPinnedForItemWithRoot('Data.xlsx', root);
    assert.equal(pinned.length, 1);
    assert.equal(pinned[0].title, 'Sheet notes');
  } finally {
    rmSync(root, { recursive: true, force: true });
    _clearPinV1Cache();
  }
});

test('getPinnedForItem: md embedded via temp root', async () => {
  _clearPinV1Cache();
  const root = mkdtempSync(join(tmpdir(), 'pins-v1-'));
  try {
    writeFileSync(join(root, 'Notes.md'), '# Title\n\nPinned: Ref | https://example.com/r\n');
    const pinned = await getPinnedForItemWithRoot('Notes.md', root);
    assert.equal(pinned.length, 1);
    assert.equal(pinned[0].title, 'Ref');
  } finally {
    rmSync(root, { recursive: true, force: true });
    _clearPinV1Cache();
  }
});

test('getPinnedForItem: missing/unsupported/external return []', async () => {
  _clearPinV1Cache();
  assert.deepEqual(await getPinnedForItem('Nope/Missing.pdf'), []);
  assert.deepEqual(await getPinnedForItem('External - Foo.txt'), []);
  assert.deepEqual(await getPinnedForItem('../outside.pdf'), []);
  const root = mkdtempSync(join(tmpdir(), 'pins-v1-'));
  try {
    writeFileSync(join(root, 'img.png'), 'fake');
    assert.deepEqual(await getPinnedForItemWithRoot('img.png', root), []);
    writeFileSync(join(root, 'Lonely.pdf'), '%PDF fake, no companion');
    assert.deepEqual(await getPinnedForItemWithRoot('Lonely.pdf', root), []);
    writeFileSync(join(root, 'Bad_1.txt'), 'Pinned: Bad | javascript:alert(1)\n');
    writeFileSync(join(root, 'Bad.pdf'), '%PDF fake');
    // malformed pin URL is skipped, not thrown
    assert.deepEqual(await getPinnedForItemWithRoot('Bad.pdf', root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
    _clearPinV1Cache();
  }
});

test('isHiddenCompanionOnDisk false for orphan (no queries/ pollution)', async () => {
  // Uses a name that cannot exist as a target; only asserts fail-closed behavior
  // without creating files under queries/.
  const hidden = await isHiddenCompanionOnDisk('__pins_v1_no_such_dir__/Ghost_1.txt');
  assert.equal(hidden, false);
});
