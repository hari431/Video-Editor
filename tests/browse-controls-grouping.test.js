import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

// Simulate the grouping sort logic from browse-controls.js
function isFolderEl(el){
  return el.getAttribute('data-is-folder') === '1' || el.getAttribute('data-type') === 'folder';
}
function makeEl(name, type, likeCount, addedMs, updatedMs){
  return {
    getAttribute: (k)=>{
      if(k==='data-name') return name.toLowerCase();
      if(k==='data-like-count') return String(likeCount||0);
      if(k==='data-added-ms') return String(addedMs||0);
      if(k==='data-updated-ms') return String(updatedMs||0);
      if(k==='data-type') return type;
      if(k==='data-is-folder') return type==='folder' ? '1' : '0';
      return null;
    },
    name, type
  };
}
function sortWithGrouping(items, fn){
  const folders = items.filter(e=>isFolderEl(e));
  const files = items.filter(e=>!isFolderEl(e));
  folders.sort(fn);
  files.sort(fn);
  return folders.concat(files);
}
function nameAsc(a,b){ return (a.getAttribute('data-name')||'').localeCompare(b.getAttribute('data-name')||''); }
function nameDesc(a,b){ return (b.getAttribute('data-name')||'').localeCompare(a.getAttribute('data-name')||''); }
function mostLiked(a,b){ const d=(parseInt(b.getAttribute('data-like-count'))||0)-(parseInt(a.getAttribute('data-like-count'))||0); return d!==0?d:nameAsc(a,b); }
function leastLiked(a,b){ const d=(parseInt(a.getAttribute('data-like-count'))||0)-(parseInt(b.getAttribute('data-like-count'))||0); return d!==0?d:nameAsc(a,b); }
function recentlyAdded(a,b){ const d=(parseInt(b.getAttribute('data-added-ms'))||0)-(parseInt(a.getAttribute('data-added-ms'))||0); return d!==0?d:nameAsc(a,b); }
function recentlyUpdated(a,b){ const d=(parseInt(b.getAttribute('data-updated-ms'))||0)-(parseInt(a.getAttribute('data-updated-ms'))||0); return d!==0?d:nameAsc(a,b); }

function makeMixed(){
  return [
    makeEl('Zebra File', 'file', 5, 100, 100),
    makeEl('Alpha Folder', 'folder', 0, 300, 300),
    makeEl('Mango File', 'file', 20, 300, 50),
    makeEl('Beta Folder', 'folder', 0, 100, 400),
    makeEl('Apple File', 'file', 10, 200, 200),
  ];
}

for (const [sortName, fn] of Object.entries({ nameAsc, nameDesc, mostLiked, leastLiked, recentlyAdded, recentlyUpdated })){
  test(`folders always precede files for ${sortName}`, ()=>{
    const sorted = sortWithGrouping(makeMixed(), fn);
    // first two should be folders
    assert.equal(sorted[0].type, 'folder');
    assert.equal(sorted[1].type, 'folder');
    // rest are files
    assert.equal(sorted[2].type, 'file');
    assert.equal(sorted[3].type, 'file');
    assert.equal(sorted[4].type, 'file');
    // never allow file between folders
    let seenFile = false;
    for (const el of sorted){
      if (el.type !== 'folder') seenFile = true;
      if (seenFile) assert.notEqual(el.type, 'folder', `folder found after file for ${sortName}`);
    }
  });
}

test('Name A→Z sorts folders among folders and files among files', ()=>{
  const items = [
    makeEl('Z Folder', 'folder', 0, 0, 0),
    makeEl('A Folder', 'folder', 0, 0, 0),
    makeEl('Z File', 'file', 0, 0, 0),
    makeEl('A File', 'file', 0, 0, 0),
  ];
  const sorted = sortWithGrouping(items, nameAsc);
  assert.deepEqual(sorted.map(e=>e.name), ['A Folder','Z Folder','A File','Z File']);
});

test('Most liked sorts within each group', ()=>{
  const items = [
    makeEl('Folder Low', 'folder', 1, 0, 0),
    makeEl('Folder High', 'folder', 10, 0, 0),
    makeEl('File Low', 'file', 1, 0, 0),
    makeEl('File High', 'file', 10, 0, 0),
  ];
  // For folders, likeCount is 0 for both (folders have 0), so sorting by mostLiked will fallback to name tie-break, but we set different likeCounts for test
  // Actually folders have like 0, but we gave them 1 and 10 to test
  const sorted = sortWithGrouping(items, mostLiked);
  assert.equal(sorted[0].name, 'Folder High');
  assert.equal(sorted[1].name, 'Folder Low');
  assert.equal(sorted[2].name, 'File High');
  assert.equal(sorted[3].name, 'File Low');
});

test('Recently updated sorts folders and files independently', ()=>{
  const items = [
    makeEl('Old Folder', 'folder', 0, 100, 100),
    makeEl('New Folder', 'folder', 0, 200, 300),
    makeEl('Old File', 'file', 0, 100, 100),
    makeEl('New File', 'file', 0, 200, 400),
  ];
  const sorted = sortWithGrouping(items, recentlyUpdated);
  // folders sorted by updated: New Folder (300) before Old Folder (100)
  // files sorted by updated: New File (400) before Old File (100)
  assert.deepEqual(sorted.map(e=>e.name), ['New Folder','Old Folder','New File','Old File']);
});

test('Recently added sorts independently', ()=>{
  const items = [
    makeEl('Folder A', 'folder', 0, 100, 0),
    makeEl('Folder B', 'folder', 0, 300, 0),
    makeEl('File X', 'file', 0, 200, 0),
    makeEl('File Y', 'file', 0, 400, 0),
  ];
  const sorted = sortWithGrouping(items, recentlyAdded);
  assert.deepEqual(sorted.map(e=>e.name), ['Folder B','Folder A','File Y','File X']);
});
