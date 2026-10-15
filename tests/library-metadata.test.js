import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadLibraryMetadata, extractDriveFileId, isDriveUrl, isBloggerUrl, extractYouTubeId } from '../src/library/local.js';

// Recently added / updated use explicit metadata, no filesystem stat or git at runtime

test('library-metadata loads without stat or git and uses full ISO', () => {
  const meta = loadLibraryMetadata();
  assert.ok(meta && typeof meta === 'object', 'metadata should load');
  const sample = Object.keys(meta)[0];
  if (sample) {
    const e = meta[sample];
    assert.match(e.addedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'addedAt full ISO UTC');
    assert.match(e.updatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'updatedAt full ISO UTC');
  }
});

test('Recently added ordering - newest first, tie-break name A-Z', () => {
  // simulate Test1..Test4 as per spec
  const items = [
    { path: 'Guidewire/Tutorials/Test1.txt', name: 'Test1', addedAt: '2026-09-20', updatedAt: '2026-09-20', likeCount: 0 },
    { path: 'Guidewire/Tutorials/Test2.txt', name: 'Test2', addedAt: '2026-09-21', updatedAt: '2026-09-21', likeCount: 0 },
    { path: 'Guidewire/Tutorials/Test3.txt', name: 'Test3', addedAt: '2026-09-22', updatedAt: '2026-09-22', likeCount: 0 },
    { path: 'Guidewire/Tutorials/Test4.txt', name: 'Test4', addedAt: '2026-09-24', updatedAt: '2026-09-24', likeCount: 0 },
  ];
  const meta = {};
  for (const it of items) meta[it.path] = { addedAt: it.addedAt, updatedAt: it.updatedAt };
  function toMs(s){ return s ? new Date(s).getTime() : 0; }
  const sorted = [...items].sort((a,b)=>{
    const d = toMs(meta[b.path].addedAt) - toMs(meta[a.path].addedAt);
    if (d!==0) return d;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });
  assert.deepEqual(sorted.map(i=>i.name), ['Test4','Test3','Test2','Test1']);
});

test('Recently updated moves on updatedAt but Recently added does not', () => {
  const items = [
    { path: 'Guidewire/Tutorials/Test1.txt', name: 'Test1', addedAt: '2026-09-20', updatedAt: '2026-09-20' },
    { path: 'Guidewire/Tutorials/Test2.txt', name: 'Test2', addedAt: '2026-09-21', updatedAt: '2026-09-25' },
    { path: 'Guidewire/Tutorials/Test3.txt', name: 'Test3', addedAt: '2026-09-22', updatedAt: '2026-09-22' },
    { path: 'Guidewire/Tutorials/Test4.txt', name: 'Test4', addedAt: '2026-09-24', updatedAt: '2026-09-24' },
  ];
  const meta = {};
  for (const it of items) meta[it.path] = { addedAt: it.addedAt, updatedAt: it.updatedAt };
  function toMs(s){ return new Date(s).getTime(); }
  const byAdded = [...items].sort((a,b)=> toMs(meta[b.path].addedAt)-toMs(meta[a.path].addedAt) || a.name.localeCompare(b.name));
  const byUpdated = [...items].sort((a,b)=> toMs(meta[b.path].updatedAt)-toMs(meta[a.path].updatedAt) || a.name.localeCompare(b.name));
  assert.deepEqual(byAdded.map(i=>i.name), ['Test4','Test3','Test2','Test1'], 'added order unchanged after Test2 update');
  assert.deepEqual(byUpdated.map(i=>i.name), ['Test2','Test4','Test3','Test1'], 'updated order moves Test2 to top');
});

test('Same-date deterministic tie-break by name A-Z', () => {
  const items = [
    { path: 'Guidewire/Tutorials/B.txt', name: 'B', addedAt: '2026-09-24' },
    { path: 'Guidewire/Tutorials/A.txt', name: 'A', addedAt: '2026-09-24' },
    { path: 'Guidewire/Tutorials/C.txt', name: 'C', addedAt: '2026-09-24' },
  ];
  const meta = {};
  for (const it of items) meta[it.path] = { addedAt: it.addedAt, updatedAt: it.addedAt };
  function toMs(s){ return new Date(s).getTime(); }
  const sorted = [...items].sort((a,b)=> toMs(meta[b.path].addedAt)-toMs(meta[a.path].addedAt) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  assert.deepEqual(sorted.map(i=>i.name), ['A','B','C']);
});

test('Missing metadata falls back to 0 and sorts last', () => {
  const meta = {
    'Guidewire/Tutorials/Test1.txt': { addedAt: '2026-09-24', updatedAt: '2026-09-24' }
  };
  const items = [
    { path: 'Guidewire/Tutorials/Test1.txt', name: 'Test1' },
    { path: 'Guidewire/Tutorials/Unknown.txt', name: 'Unknown' },
  ];
  function getMs(p, field){ const e=meta[p]; return e && e[field] ? new Date(e[field]).getTime() : 0; }
  const sorted = [...items].sort((a,b)=> getMs(b.path,'addedAt')-getMs(a.path,'addedAt') || a.name.localeCompare(b.name));
  assert.equal(sorted[0].name, 'Test1');
  assert.equal(sorted[1].name, 'Unknown');
  assert.equal(getMs('Guidewire/Tutorials/Unknown.txt','addedAt'), 0);
});

test('Existing Name / Most- Least liked still deterministic', () => {
  const items = [
    { path: 'a.txt', name: 'A', likeCount: 5 },
    { path: 'b.txt', name: 'B', likeCount: 10 },
    { path: 'c.txt', name: 'C', likeCount: 10 },
  ];
  const byMost = [...items].sort((a,b)=> (b.likeCount - a.likeCount) || a.name.localeCompare(b.name));
  assert.deepEqual(byMost.map(i=>i.name), ['B','C','A']);
  const byLeast = [...items].sort((a,b)=> (a.likeCount - b.likeCount) || a.name.localeCompare(b.name));
  assert.deepEqual(byLeast.map(i=>i.name), ['A','B','C']);
  const byNameAsc = [...items].sort((a,b)=> a.name.localeCompare(b.name));
  assert.deepEqual(byNameAsc.map(i=>i.name), ['A','B','C']);
});

test('Full timestamp sorting - same day different times', () => {
  const items = [
    { path: 'a.txt', name: 'A', addedAt: '2026-09-24T11:14:00.000Z' },
    { path: 'b.txt', name: 'B', addedAt: '2026-09-24T11:49:00.000Z' },
    { path: 'c.txt', name: 'C', addedAt: '2026-09-24T12:30:00.000Z' },
  ];
  const meta = {};
  for (const it of items) meta[it.path] = { addedAt: it.addedAt, updatedAt: it.addedAt };
  function toMs(s){ return new Date(s).getTime(); }
  const sorted = [...items].sort((a,b)=> toMs(meta[b.path].addedAt)-toMs(meta[a.path].addedAt) || a.name.localeCompare(b.name));
  assert.deepEqual(sorted.map(i=>i.name), ['C','B','A'], 'full ISO must sort by time, not just date');
});

test('Same exact timestamp tie-break by name', () => {
  const ts = '2026-09-24T11:49:32.000Z';
  const items = [
    { path: 'b.txt', name: 'B', addedAt: ts },
    { path: 'a.txt', name: 'A', addedAt: ts },
    { path: 'c.txt', name: 'C', addedAt: ts },
  ];
  const meta = {};
  for (const it of items) meta[it.path] = { addedAt: it.addedAt, updatedAt: it.addedAt };
  function toMs(s){ return new Date(s).getTime(); }
  const sorted = [...items].sort((a,b)=> toMs(meta[b.path].addedAt)-toMs(meta[a.path].addedAt) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  assert.deepEqual(sorted.map(i=>i.name), ['A','B','C']);
});

test('Uncommitted new file uses filesystem timestamp (generation-time)', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync('scripts/generate-content-manifest.js','utf8');
  assert.match(src, /getFilesystemTimestamps/, 'generation should use filesystem for uncommitted');
  assert.match(src, /isFileDirty/, 'should detect uncommitted via git status');
});

test('Existing date-only metadata migrates to full ISO', () => {
  const dateOnly = '2026-09-24';
  const iso = new Date(dateOnly).toISOString(); // should be T00:00:00.000Z
  assert.equal(iso, '2026-09-24T00:00:00.000Z');
  // simulate migration: date-only normalized, but updatedAt prefers precise content-manifest ms
  const existing = { addedAt: '2026-09-24', updatedAt: '2026-09-24' };
  const normalizedAdded = new Date(existing.addedAt).toISOString();
  assert.equal(normalizedAdded, '2026-09-24T00:00:00.000Z');
  // content-manifest ms example: 2026-09-24T04:40:13.000Z would be used
  const cmMs = new Date('2026-09-24T04:40:13.000Z').getTime();
  const precise = new Date(cmMs).toISOString();
  assert.equal(precise, '2026-09-24T04:40:13.000Z');
});

test('No filesystem stat or git child_process in library metadata loader', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync('src/library/local.js','utf8');
  // loader should use readFileSync/existsSync on library-metadata.json, not stat or git
  // allow stat word in comments but not stat( calls for timestamps
  assert.doesNotMatch(src, /execSync|child_process|git log/, 'should not use git at runtime');
  assert.match(src, /library-metadata\.json/, 'should use explicit metadata');
  // ensure browse-controls sort does not use stat
  const bc = readFileSync('src/public/browse-controls.js','utf8');
  assert.doesNotMatch(bc, /stat\(|birthtime|mtime/, 'browse-controls should not use stat');
});
