import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  isCompanionMetadataFilename,
  isCompanionableParentFilename,
  companionableExtensions,
  companionPathForItem,
  companionTargetCandidates,
  isHiddenCompanionPath,
  findCompanionParentOnDiskWithRoot,
  isHiddenCompanionOnDisk,
} from '../src/library/local.js';
import {
  parsePinnedReferences,
  getPinnedForItemWithRoot,
  getPinnedForItem,
  _clearPinV1Cache,
} from '../src/library/pinned.js';
import {
  isCompanionMetadataName,
  hasCompanionTargetSync,
} from '../scripts/generate-content-manifest.js';

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'pins-v2-'));
}

// --- Generic companion mapping (§2, §14) ---

test('v2 generic mapping: one resolver for all binary types', () => {
  assert.equal(companionPathForItem('Guide.pdf'), 'Guide_1.txt');
  assert.equal(companionPathForItem('Guide.xlsx'), 'Guide_1.txt');
  assert.equal(companionPathForItem('Guide.docx'), 'Guide_1.txt');
  assert.equal(companionPathForItem('Guide.pptx'), 'Guide_1.txt');
  assert.equal(companionPathForItem('Guide.png'), 'Guide_1.txt');
  assert.equal(companionPathForItem('Guide.zip'), 'Guide_1.txt');
  assert.equal(companionPathForItem('Guide.doc'), 'Guide_1.txt');
  assert.equal(companionPathForItem('Guide.xls'), 'Guide_1.txt');
  assert.equal(companionPathForItem('Guide.ppt'), 'Guide_1.txt');
});

test('v2 mapping: spaces, multiple dots, subdirs', () => {
  assert.equal(companionPathForItem('A/My Guide.pdf'), 'A/My Guide_1.txt');
  assert.equal(companionPathForItem('Guidewire.PC.Rating.xlsx'), 'Guidewire.PC.Rating_1.txt');
  assert.equal(companionPathForItem('V/Version 10.0.pptx'), 'V/Version 10.0_1.txt');
});

test('v2 mapping: never Guide_1_1.txt, rejects traversal', () => {
  assert.equal(companionPathForItem('Guide_1.txt'), null);
  assert.equal(companionPathForItem('A/Guide_1.txt'), null);
  assert.equal(companionPathForItem('../secret.pdf'), null);
  assert.equal(companionPathForItem('/abs/path.pdf'), null);
  assert.equal(companionPathForItem('A/../../evil.pdf'), null);
  assert.equal(companionPathForItem('noext'), null);
  assert.equal(companionPathForItem('External - Guide.pdf'), null);
});

// --- Companionable parents: registry-derived, nothing invented (§3, §10) ---

test('v2 companionable parents follow the library registry', () => {
  for (const ext of ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.csv', '.ppt', '.pptx',
    '.jpg', '.jpeg', '.png', '.gif', '.webp', '.zip']) {
    assert.equal(isCompanionableParentFilename(`Guide${ext}`), true, ext);
    assert.equal(isCompanionableParentFilename(`GUIDE${ext.toUpperCase()}`), true, ext);
  }
  // Text/markdown use embedded pins; video pages never render pins; unknown
  // extensions are not library items — none of these activate hiding.
  for (const name of ['Notes.txt', 'Notes.md', 'Clip.mp4', 'Clip.webm', 'Notes.xyz',
    'Notes', 'External - Guide.pdf', 'Guide_1.txt', '']) {
    assert.equal(isCompanionableParentFilename(name), false, name);
  }
  // Extensions the library does NOT recognize invent no behavior.
  for (const ext of ['.rtf', '.odt', '.ods', '.odp', '.svg', '.bmp', '.tiff', '.7z', '.rar']) {
    assert.equal(isCompanionableParentFilename(`Guide${ext}`), false, ext);
  }
});

test('v2 companionableExtensions derived once, deterministic', () => {
  const a = companionableExtensions();
  const b = companionableExtensions();
  assert.ok(a === b, 'cached reference');
  for (const ext of ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
    '.png', '.jpg', '.zip']) {
    assert.ok(a.includes(ext), `missing ${ext}`);
  }
  for (const ext of ['.txt', '.md', '.mp4', '.webm', '.mov']) {
    assert.ok(!a.includes(ext), `must exclude ${ext}`);
  }
});

// --- Hidden behavior via predicates (§7, §9) ---

test('v2 hidden: active for new binary types, orphan stays visible', () => {
  const tree = new Set([
    'a/architecture.pptx',
    'a/photo.png',
    'a/bundle.zip',
    'a/legacy.doc',
    'a/sheet.xls',
    'a/deck.ppt',
  ]);
  for (const stem of ['Architecture', 'photo', 'bundle', 'legacy', 'sheet', 'deck']) {
    assert.equal(isHiddenCompanionPath(`A/${stem}_1.txt`, tree), true, stem);
  }
  // txt/mp4 parents never hide; orphan without any parent stays a normal file.
  assert.equal(isHiddenCompanionPath('A/Notes_1.txt', new Set(['a/notes.txt'])), false);
  assert.equal(isHiddenCompanionPath('A/Clip_1.txt', new Set(['a/clip.mp4'])), false);
  assert.equal(isHiddenCompanionPath('A/Something_1.txt', tree), false);
  assert.equal(isHiddenCompanionPath('A/Something_1.txt', new Set()), false);
});

test('v2 walk-filter contract: active hidden, orphans kept', () => {
  // Mirrors the readQueryLibrary post-walk filter over discovered paths.
  const discovered = ['a/slides.pptx', 'a/slides_1.txt', 'a/orphan_1.txt', 'a/notes.txt'];
  const lowerSet = new Set(discovered.map(p => p.toLowerCase()));
  const kept = discovered.filter(p => {
    const base = p.split('/').pop() || '';
    if (isCompanionMetadataFilename(base) && isHiddenCompanionPath(p, lowerSet)) return false;
    return true;
  });
  assert.ok(!kept.includes('a/slides_1.txt'), 'active companion excluded');
  assert.ok(kept.includes('a/orphan_1.txt'), 'orphan stays visible');
  assert.ok(kept.includes('a/slides.pptx') && kept.includes('a/notes.txt'));
});

// --- Sidecar pins for representative binary types (§6, §11, §12) ---

test('v2 sidecar pins detected for pdf/xlsx/pptx/doc/png/zip/xls', async () => {
  _clearPinV1Cache();
  const root = tempRoot();
  try {
    const cases = [
      ['Report.pdf', '%PDF-1.4 fake'],
      ['Tables.xlsx', 'PK\x03\x04 fake-xlsx'],
      ['Slides.pptx', 'PK\x03\x04 fake-pptx'],
      ['Legacy.doc', '\xD0\xCF\x11\xE0 fake-doc'],
      ['Photo.png', '\x89PNG fake-bytes'],
      ['Bundle.zip', 'PK\x03\x04 fake-zip'],
      ['Old.xls', '\xD0\xCF\x11\xE0 fake-xls'],
    ];
    for (const [parent, bytes] of cases) {
      const stem = parent.replace(/\.[^.]+$/, '');
      writeFileSync(join(root, parent), bytes);
      writeFileSync(join(root, `${stem}_1.txt`),
        `Pinned: Premium | ${stem} Part 2 | /query/a\nPinned: ${stem} Notes | https://example.com/${stem}\n`);
    }
    for (const [parent] of cases) {
      const stem = parent.replace(/\.[^.]+$/, '');
      const pinned = await getPinnedForItemWithRoot(parent, root);
      assert.equal(pinned.length, 2, parent);
      assert.equal(pinned[0].access, 'premium', parent);
      assert.equal(pinned[0].title, `${stem} Part 2`, parent);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    _clearPinV1Cache();
  }
});

test('v2 binary bytes are never parsed for Pins', async () => {
  _clearPinV1Cache();
  const root = tempRoot();
  try {
    // Decoy Pin-like line lives INSIDE the binary; only the sidecar counts.
    writeFileSync(join(root, 'Tricky.pdf'), 'binary blob\nPinned: Decoy | https://decoy.example/\nmore blob');
    writeFileSync(join(root, 'Tricky_1.txt'), 'Pinned: Real | https://example.com/real\n');
    const pinned = await getPinnedForItemWithRoot('Tricky.pdf', root);
    assert.equal(pinned.length, 1);
    assert.equal(pinned[0].title, 'Real');
  } finally {
    rmSync(root, { recursive: true, force: true });
    _clearPinV1Cache();
  }
});

test('v2 sidecar uses canonical parser (premium/null/invalid)', async () => {
  _clearPinV1Cache();
  const root = tempRoot();
  try {
    writeFileSync(join(root, 'Training.pptx'), 'PK fake');
    writeFileSync(join(root, 'Training_1.txt'),
      'Pinned: Guidewire ACE | /query/Guidewire/ACE.txt\n' +
      'Pinned: Premium | Advanced Rating | /external/Premium/Rating.txt\n' +
      'Pinned: Null | Plain | https://example.com/plain\n' +
      'Pinned: Bad | javascript:alert(1)\n' +
      'Pinned:\n');
    const pinned = await getPinnedForItemWithRoot('Training.pptx', root);
    assert.equal(pinned.length, 3);
    assert.equal(pinned[0].title, 'Guidewire ACE');
    assert.equal(pinned[1].access, 'premium');
    assert.equal(pinned[2].access, 'normal');
  } finally {
    rmSync(root, { recursive: true, force: true });
    _clearPinV1Cache();
  }
});

// --- DOCX union preserved (§5) ---

test('v2 docx: embedded + sidecar union, dedupe, order', async () => {
  _clearPinV1Cache();
  let JSZip = null;
  try {
    ({ default: JSZip } = await import('jszip'));
  } catch {
    // jszip is a transitive dep (via mammoth); skip rather than fail.
    return;
  }
  const root = tempRoot();
  try {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    zip.file('word/document.xml', '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Body</w:t></w:r></w:p><w:p><w:r><w:t>Pinned: Embedded One | https://example.com/one</w:t></w:r></w:p><w:p><w:r><w:t>Pinned: Shared | https://example.com/shared</w:t></w:r></w:p></w:body></w:document>');
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    writeFileSync(join(root, 'Union.docx'), buf);
    writeFileSync(join(root, 'Union_1.txt'),
      'Pinned: Shared | https://example.com/shared\nPinned: Premium | Sidecar Two | /query/b\n');
    const pinned = await getPinnedForItemWithRoot('Union.docx', root);
    assert.deepEqual(pinned.map(p => p.title), ['Embedded One', 'Shared', 'Sidecar Two']);
    assert.equal(pinned[2].access, 'premium');
  } finally {
    rmSync(root, { recursive: true, force: true });
    _clearPinV1Cache();
  }
});

// --- Parent validation on disk, incl. case variance (§10, §15) ---

test('v2 findCompanionParentOnDiskWithRoot: exact, case-variant, orphan, traversal', async () => {
  const root = tempRoot();
  try {
    mkdirSync(join(root, 'A'), { recursive: true });
    writeFileSync(join(root, 'A', 'Slides.pptx'), 'PK fake');
    writeFileSync(join(root, 'A', 'Slides_1.txt'), 'Pinned: x | https://example.com/x\n');
    writeFileSync(join(root, 'A', 'GUIDE.PDF'), '%PDF fake');
    writeFileSync(join(root, 'A', 'Guide_1.txt'), 'Pinned: y | https://example.com/y\n');
    writeFileSync(join(root, 'A', 'Lonely_1.txt'), 'Pinned: z | https://example.com/z\n');

    assert.equal(await findCompanionParentOnDiskWithRoot('A/Slides_1.txt', root), 'A/Slides.pptx');
    // Case-insensitive fallback: GUIDE.PDF activates Guide_1.txt (on Windows
    // the exact-case stat hits first; either way the parent is found).
    const caseFound = await findCompanionParentOnDiskWithRoot('A/Guide_1.txt', root);
    assert.ok(caseFound && caseFound.toLowerCase() === 'a/guide.pdf', `got ${caseFound}`);
    assert.equal(await findCompanionParentOnDiskWithRoot('A/Lonely_1.txt', root), null);
    assert.equal(await findCompanionParentOnDiskWithRoot('../evil_1.txt', root), null);
    assert.equal(await findCompanionParentOnDiskWithRoot('A/Notes.txt', root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('v2 case-variant sidecar filename still resolves pins', async () => {
  _clearPinV1Cache();
  const root = tempRoot();
  try {
    writeFileSync(join(root, 'Report.pdf'), '%PDF fake');
    // Sidecar stored in different case: exact stat hits on Windows, the
    // case-insensitive directory scan covers Linux — pins resolve on both.
    writeFileSync(join(root, 'REPORT_1.txt'), 'Pinned: Case | https://example.com/case\n');
    const pinned = await getPinnedForItemWithRoot('Report.pdf', root);
    assert.equal(pinned.length, 1);
    assert.equal(pinned[0].title, 'Case');
  } finally {
    rmSync(root, { recursive: true, force: true });
    _clearPinV1Cache();
  }
});

// --- Failure cases: none break the parent (§21) ---

test('v2 failures resolve to [] without breaking parents', async () => {
  _clearPinV1Cache();
  const root = tempRoot();
  try {
    writeFileSync(join(root, 'Lonely.pdf'), '%PDF no companion');
    assert.deepEqual(await getPinnedForItemWithRoot('Lonely.pdf', root), []);

    writeFileSync(join(root, 'Empty.pdf'), '%PDF empty sidecar');
    writeFileSync(join(root, 'Empty_1.txt'), '');
    assert.deepEqual(await getPinnedForItemWithRoot('Empty.pdf', root), []);

    // Oversized sidecar: pin beyond the 64KB cap is dropped, not fatal.
    writeFileSync(join(root, 'Big.pdf'), '%PDF big');
    writeFileSync(join(root, 'Big_1.txt'), `${'x'.repeat(70 * 1024)}\nPinned: Late | https://example.com/late\n`);
    assert.deepEqual(await getPinnedForItemWithRoot('Big.pdf', root), []);

    // Unsupported extension: sidecar ignored even when present.
    writeFileSync(join(root, 'Weird.foo'), 'fake');
    writeFileSync(join(root, 'Weird_1.txt'), 'Pinned: x | https://example.com/x\n');
    assert.deepEqual(await getPinnedForItemWithRoot('Weird.foo', root), []);
    assert.equal(isHiddenCompanionPath('Weird_1.txt', new Set(['weird.foo'])), false);

    // Missing parent + traversal.
    assert.deepEqual(await getPinnedForItemWithRoot('Ghost/gone.pdf', root), []);
    assert.deepEqual(await getPinnedForItemWithRoot('../outside.pdf', root), []);

    // External never yields pins.
    assert.deepEqual(await getPinnedForItem('External - Foo.pdf'), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
    _clearPinV1Cache();
  }
});

test('v2 orphan companion behaves as normal txt (visible, no parent pins)', async () => {
  _clearPinV1Cache();
  const root = tempRoot();
  try {
    writeFileSync(join(root, 'Notes_1.txt'), 'just notes\nPinned: x | https://example.com/x\n');
    // As a companion path it yields nothing (no parent)...
    assert.equal(isHiddenCompanionPath('Notes_1.txt', new Set(['notes_1.txt'])), false);
    // ...and direct production lookup stays fail-closed.
    assert.deepEqual(await getPinnedForItem('__v2_no_such__/Notes_1.txt'), []);
    assert.equal(await isHiddenCompanionOnDisk('__v2_no_such__/Notes_1.txt'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    _clearPinV1Cache();
  }
});

// --- Manifest exclusion mirrors the generic rule (§18) ---

test('v2 manifest helpers: active hidden, orphans kept, case-insensitive', () => {
  const root = tempRoot();
  try {
    mkdirSync(join(root, 'M'), { recursive: true });
    writeFileSync(join(root, 'M', 'Training.pptx'), 'PK');
    writeFileSync(join(root, 'M', 'Training_1.txt'), 'pins');
    writeFileSync(join(root, 'M', 'GUIDE.PDF'), '%PDF');
    writeFileSync(join(root, 'M', 'Guide_1.txt'), 'pins');
    writeFileSync(join(root, 'M', 'Orphan_1.txt'), 'orphan');
    writeFileSync(join(root, 'M', 'Clip.mp4'), 'fake');
    writeFileSync(join(root, 'M', 'Clip_1.txt'), 'pins');
    const dir = join(root, 'M');

    assert.equal(isCompanionMetadataName('Training_1.txt'), true);
    assert.equal(isCompanionMetadataName('External - Training_1.txt'), false);
    assert.equal(hasCompanionTargetSync(dir, 'Training_1.txt'), true);
    assert.equal(hasCompanionTargetSync(dir, 'Guide_1.txt'), true);
    assert.equal(hasCompanionTargetSync(dir, 'Orphan_1.txt'), false);
    // txt/mp4-adjacent _1.txt files are not companions.
    assert.equal(hasCompanionTargetSync(dir, 'Clip_1.txt'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('v2 canonical parser still the only parser', () => {
  const { pinned } = parsePinnedReferences('Pinned: Premium | T | https://example.com/\nPinned: U | /query/a');
  assert.equal(pinned.length, 2);
  assert.equal(pinned[0].access, 'premium');
  assert.equal(pinned[1].access, 'normal');
});
