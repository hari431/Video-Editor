import './helpers/env.js';
process.env.HIDDEN_FOLDERS = 'Internal,Drafts';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookieSignature from 'cookie-signature';
import { pool } from '../src/db/pool.js';
import { buildTree } from '../src/library/tree.js';
import { getRelatedContent, MAX_RELATED, areaRootForPath } from '../src/library/related.js';
import { contentRouteForPath } from '../src/library/local.js';
import { invalidatePermissionCache } from '../src/library/local.js';

const { app } = await import('../src/server.js');

const QUERIES_DIR = fileURLToPath(new URL('../queries/', import.meta.url));

const SID = 'related-harness-session';
const COOKIE = `connect.sid=s:${cookieSignature.sign(SID, process.env.SESSION_SECRET)}`;

const USER = {
  id: 201,
  google_user_id: 'google-related-1',
  email: 'related@example.com',
  name: 'Related Tester',
  status: 'active',
  first_login_at: new Date(),
  last_login_at: new Date(),
  access_expires_at: new Date(Date.now() + 30 * 86400000),
  app_role: 'user'
};

const TEST_BASE = '__related_test';
const MANY_BASE = '__related_many';
const SOLO_BASE = '__related_solo';
const RESTRICTED_BASE = '__related_restricted';

// Mutable permission rows so tests can simulate inaccessible content.
let permRows = [
  { folder_path: 'Guidewire', access_level: 'all', role_id: null },
  { folder_path: 'Tutorials', access_level: 'all', role_id: null },
  { folder_path: 'Videos', access_level: 'all', role_id: null },
  { folder_path: TEST_BASE, access_level: 'all', role_id: null },
  { folder_path: MANY_BASE, access_level: 'all', role_id: null },
  { folder_path: SOLO_BASE, access_level: 'all', role_id: null },
  { folder_path: RESTRICTED_BASE, access_level: 'all', role_id: null }
];

let originalQuery = null;
let server = null;
let port = 0;

const enc = value => value.split('/').map(encodeURIComponent).join('/');
const http = (suffix, init) => fetch(`http://127.0.0.1:${port}${suffix}`, init);

function relatedSection(html) {
  const start = html.indexOf('data-testid="related-content"');
  if (start === -1) return null;
  // Return a window around the section plus remainder (section is near bottom)
  return html.slice(start);
}

function countRelatedCards(html) {
  const section = relatedSection(html);
  if (!section) return 0;
  // Count card links inside the related section: from marker to Discussions heading
  const end = section.indexOf('Have a question?');
  const body = end === -1 ? section : section.slice(0, end);
  return (body.match(/class="card"/g) || []).length;
}

// ---------- unit helpers ----------
function leaf(p, type = 'file') {
  return { path: p, name: p.split('/').at(-1), type };
}
function unitTree() {
  const files = [
    leaf('Guidewire/Gosu/PC/Rating/a.txt'),
    leaf('Guidewire/Gosu/PC/Rating/b.txt'),
    leaf('Guidewire/Gosu/PC/Rating/c.txt'),
    leaf('Guidewire/Gosu/PC/Config/d.txt'),
    leaf('Guidewire/Gosu/BC/Claims/e.txt')
  ];
  const videos = [{ path: 'Tutorials/vid.mp4', name: 'vid.mp4', type: 'video' }];
  const items = [
    { path: 'Guidewire/Gosu/PC/Rating/doc.pdf', name: 'doc.pdf', type: 'pdf' },
    { path: 'Guidewire/Gosu/PC/Rating/sheet.xlsx', name: 'sheet.xlsx', type: 'spreadsheet' },
    { path: 'Guidewire/Gosu/PC/Rating/pic.png', name: 'pic.png', type: 'image' }
  ];
  const folders = ['Guidewire', 'Guidewire/Gosu', 'Guidewire/Gosu/PC', 'Guidewire/Gosu/PC/Rating', 'Guidewire/Gosu/PC/Config', 'Guidewire/Gosu/BC', 'Guidewire/Gosu/BC/Claims', 'Tutorials'];
  return buildTree(files, videos, folders, items);
}
const allowAll = () => true;
const existsAll = async () => true;

// ---------- setup ----------
test.before(async () => {
  const base = path.join(QUERIES_DIR, TEST_BASE);
  await mkdir(base, { recursive: true });
  await writeFile(path.join(base, 'noteA.txt'), 'alpha content');
  await writeFile(path.join(base, 'noteB.txt'), 'beta content');
  await writeFile(path.join(base, 'noteC.txt'), 'gamma content');
  await writeFile(path.join(base, 'doc.pdf'), randomBytes(128));
  await writeFile(path.join(base, 'sheet.xlsx'), randomBytes(128));
  await writeFile(path.join(base, 'image.png'), randomBytes(128));
  await mkdir(path.join(base, 'sub'), { recursive: true });
  await writeFile(path.join(base, 'sub', 'deep.txt'), 'deep content');

  const many = path.join(QUERIES_DIR, MANY_BASE);
  await mkdir(many, { recursive: true });
  for (let i = 0; i < 8; i++) {
    await writeFile(path.join(many, `file${i}.txt`), `content ${i}`);
  }

  const solo = path.join(QUERIES_DIR, SOLO_BASE);
  await mkdir(solo, { recursive: true });
  await writeFile(path.join(solo, 'solo.txt'), 'lonely content');

  const restricted = path.join(QUERIES_DIR, RESTRICTED_BASE);
  await mkdir(restricted, { recursive: true });
  await writeFile(path.join(restricted, 'secret.txt'), 'secret content');

  originalQuery = pool.query;
  pool.query = async (sql, params = []) => {
    if (/SELECT to_regclass/.test(sql)) return { rows: [{ to_regclass: 'user_sessions' }] };
    if (/SELECT sess FROM ["']?user_sessions["']?/i.test(sql)) {
      return { rows: [{ sess: JSON.stringify({ cookie: {}, passport: { user: 201 } }) }] };
    }
    if (/SELECT \* FROM users WHERE id = \$1/i.test(sql)) return { rows: [USER] };
    if (/user_roles/.test(sql)) return { rows: [] };
    if (/folder_permissions/.test(sql)) return { rows: permRows };
    if (/item_likes/.test(sql)) {
      if (/COUNT/.test(sql)) return { rows: [{ cnt: '0' }] };
      return { rows: [] };
    }
    if (/video_views/.test(sql)) return { rows: [{ cnt: '0' }] };
    if (/query_usage/.test(sql)) return { rows: [] };
    if (/discussions/.test(sql) || /discussion_replies/.test(sql)) return { rows: [] };
    if (/recently_viewed/.test(sql)) return { rows: [] };
    return { rows: [] };
  };

  server = await new Promise(resolve => {
    const s = app.listen(0, () => resolve(s));
  });
  port = server.address().port;
});

test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  if (originalQuery) {
    pool.query = originalQuery;
    originalQuery = null;
  }
  for (const dir of [TEST_BASE, MANY_BASE, SOLO_BASE, RESTRICTED_BASE]) {
    try { await rm(path.join(QUERIES_DIR, dir), { recursive: true, force: true }); } catch {}
  }
});

// ---------- unit tests ----------
test('unit: same-category items are preferred', async () => {
  const tree = unitTree();
  const items = await getRelatedContent(tree, 'Guidewire/Gosu/PC/Rating/a.txt', {}, {
    canAccess: allowAll,
    existsAsync: existsAll
  });
  assert.ok(items.length > 0);
  // First picks must be from the same Rating folder
  const firstThree = items.slice(0, 3).map(i => i.path);
  for (const p of firstThree) {
    assert.ok(p.startsWith('Guidewire/Gosu/PC/Rating/'), `expected same-folder first, got ${p}`);
  }
});

test('unit: current item is excluded', async () => {
  const tree = unitTree();
  const current = 'Guidewire/Gosu/PC/Rating/b.txt';
  const items = await getRelatedContent(tree, current, {}, { canAccess: allowAll, existsAsync: existsAll });
  assert.ok(!items.some(i => i.path === current));
});

test('unit: maximum 6 items', async () => {
  const files = [];
  for (let i = 0; i < 10; i++) files.push(leaf(`F/f${i}.txt`));
  const tree = buildTree(files, [], ['F'], []);
  assert.equal(MAX_RELATED, 6);
  const items = await getRelatedContent(tree, 'F/f0.txt', {}, { canAccess: allowAll, existsAsync: existsAll });
  assert.equal(items.length, 6);
});

test('unit: inaccessible items are excluded', async () => {
  const tree = unitTree();
  const items = await getRelatedContent(tree, 'Guidewire/Gosu/PC/Rating/a.txt', {}, {
    canAccess: (u, p) => p !== 'Guidewire/Gosu/PC/Rating/b.txt',
    existsAsync: existsAll
  });
  assert.ok(!items.some(i => i.path === 'Guidewire/Gosu/PC/Rating/b.txt'));
});

test('unit: missing items are excluded', async () => {
  const tree = unitTree();
  const items = await getRelatedContent(tree, 'Guidewire/Gosu/PC/Rating/a.txt', {}, {
    canAccess: allowAll,
    existsAsync: async p => p !== 'Guidewire/Gosu/PC/Rating/b.txt'
  });
  assert.ok(!items.some(i => i.path === 'Guidewire/Gosu/PC/Rating/b.txt'));
});

test('unit: empty result when nothing else is available', async () => {
  const tree = buildTree([leaf('Solo/only.txt')], [], ['Solo'], []);
  const items = await getRelatedContent(tree, 'Solo/only.txt', {}, { canAccess: allowAll, existsAsync: existsAll });
  assert.deepEqual(items, []);
});

test('unit: correct routes for different content types', async () => {
  const tree = unitTree();
  const items = await getRelatedContent(tree, 'Guidewire/Gosu/PC/Rating/a.txt', {}, { canAccess: allowAll, existsAsync: existsAll });
  const byPath = new Map(items.map(i => [i.path, i]));
  assert.equal(byPath.get('Guidewire/Gosu/PC/Rating/b.txt').href, '/query/' + enc('Guidewire/Gosu/PC/Rating/b.txt'));
  assert.equal(byPath.get('Guidewire/Gosu/PC/Rating/doc.pdf').href, '/item/' + enc('Guidewire/Gosu/PC/Rating/doc.pdf'));
  assert.equal(byPath.get('Guidewire/Gosu/PC/Rating/sheet.xlsx').href, '/item/' + enc('Guidewire/Gosu/PC/Rating/sheet.xlsx'));
  assert.equal(byPath.get('Guidewire/Gosu/PC/Rating/pic.png').href, '/item/' + enc('Guidewire/Gosu/PC/Rating/pic.png'));
  // video route
  const vidItems = await getRelatedContent(tree, 'Tutorials/vid.mp4', {}, { canAccess: allowAll, existsAsync: existsAll });
  const txtHit = vidItems.find(i => i.path.endsWith('.txt'));
  assert.ok(txtHit);
  assert.equal(contentRouteForPath('Tutorials/vid.mp4'), '/watch/');
  assert.equal(contentRouteForPath('Guidewire/Gosu/PC/Rating/a.txt'), '/query/');
  assert.equal(contentRouteForPath('Guidewire/Gosu/PC/Rating/doc.pdf'), '/item/');
});

test('unit: deterministic ordering', async () => {
  const tree = unitTree();
  const a = await getRelatedContent(tree, 'Guidewire/Gosu/PC/Rating/a.txt', {}, { canAccess: allowAll, existsAsync: existsAll });
  const b = await getRelatedContent(tree, 'Guidewire/Gosu/PC/Rating/a.txt', {}, { canAccess: allowAll, existsAsync: existsAll });
  assert.deepEqual(a, b);
});

test('unit: broader PC area preferred over other areas', async () => {
  const tree = buildTree(
    [leaf('Guidewire/Gosu/PC/Rating/a.txt'), leaf('Guidewire/Gosu/PC/Config/d.txt'), leaf('Guidewire/Gosu/BC/Claims/e.txt'), leaf('Other/z.txt')],
    [], ['Guidewire', 'Guidewire/Gosu', 'Guidewire/Gosu/PC', 'Guidewire/Gosu/PC/Rating', 'Guidewire/Gosu/PC/Config', 'Guidewire/Gosu/BC', 'Guidewire/Gosu/BC/Claims', 'Other'], []
  );
  const items = await getRelatedContent(tree, 'Guidewire/Gosu/PC/Rating/a.txt', {}, { canAccess: allowAll, existsAsync: existsAll });
  const paths = items.map(i => i.path);
  const pcIdx = paths.indexOf('Guidewire/Gosu/PC/Config/d.txt');
  const bcIdx = paths.indexOf('Guidewire/Gosu/BC/Claims/e.txt');
  assert.ok(pcIdx !== -1 && bcIdx !== -1);
  assert.ok(pcIdx < bcIdx, 'PC area should rank before BC area');
});

test('unit: folders are never included and area root helper works', async () => {
  const tree = unitTree();
  const items = await getRelatedContent(tree, 'Guidewire/Gosu/PC/Rating/a.txt', {}, { canAccess: allowAll, existsAsync: existsAll });
  for (const i of items) {
    assert.ok(!i.path.endsWith('/Rating') && !i.path.endsWith('/Config'));
    assert.ok(i.href.startsWith('/query/') || i.href.startsWith('/watch/') || i.href.startsWith('/item/'));
  }
  assert.equal(areaRootForPath('Guidewire/Gosu/PC/Rating/a.txt'), 'Guidewire/Gosu/PC');
  assert.equal(areaRootForPath('Tutorials/vid.mp4'), null);
});

// ---------- integration tests ----------
test('integration: query page displays related items and excludes current', async () => {
  const p = `${TEST_BASE}/noteA.txt`;
  const res = await http(`/query/${enc(p)}`, { headers: { Cookie: COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /data-testid="related-content"/);
  assert.match(html, /Related Content/);
  // siblings shown
  assert.ok(html.includes('/query/' + enc(`${TEST_BASE}/noteB.txt`)));
  // current item link must not appear inside related section
  const section = relatedSection(html);
  assert.ok(section);
  assert.ok(!section.includes(`/query/${enc(p)}"`) || section.indexOf(`/query/${enc(p)}"`) === -1 || !section.split('Have a question?')[0].includes(`/query/${enc(p)}`),
    'current item should not be linked in related section');
  // each card shows type + category
  assert.match(html, /Text/);
  assert.match(html, new RegExp(TEST_BASE));
  // discussions still present
  assert.match(html, /Have a question\?/);
});

test('integration: item (PDF/Excel/Image) pages display related with correct routes', async () => {
  for (const file of ['doc.pdf', 'sheet.xlsx', 'image.png']) {
    const p = `${TEST_BASE}/${file}`;
    const res = await http(`/item/${enc(p)}`, { headers: { Cookie: COOKIE } });
    assert.equal(res.status, 200, `expected 200 for ${file}`);
    const html = await res.text();
    assert.match(html, /data-testid="related-content"/, `${file} should show related`);
    // txt sibling via /query/, pdf sibling via /item/
    assert.ok(html.includes('/query/' + enc(`${TEST_BASE}/noteA.txt`)), `${file} page should link txt via /query/`);
    assert.match(html, /Have a question\?/);
  }
});

test('integration: video page displays related content', async () => {
  const p = 'Videos/Finding Rate table & Routine Usages.mp4';
  const res = await http(`/watch/${enc(p)}`, { headers: { Cookie: COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /data-testid="related-content"/);
  assert.match(html, /Have a question\?/);
});

test('integration: maximum 6 related items', async () => {
  const p = `${MANY_BASE}/file0.txt`;
  const res = await http(`/query/${enc(p)}`, { headers: { Cookie: COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();
  const n = countRelatedCards(html);
  assert.ok(n > 0 && n <= 6, `expected 1..6 cards, got ${n}`);
  assert.equal(n, 6, 'many folder with 8 files should show exactly 6 (excluding current)');
});

test('integration: inaccessible content is excluded', async () => {
  permRows = permRows.filter(r => r.folder_path !== RESTRICTED_BASE);
  invalidatePermissionCache();
  await new Promise(r => setTimeout(r, 50));
  try {
    const p = `${TEST_BASE}/noteA.txt`;
    const res = await http(`/query/${enc(p)}`, { headers: { Cookie: COOKIE } });
    assert.equal(res.status, 200);
    const html = await res.text();
    const section = relatedSection(html);
    assert.ok(section);
    assert.ok(!section.includes(enc(`${RESTRICTED_BASE}/secret.txt`)), 'restricted item must not appear');
  } finally {
    permRows.push({ folder_path: RESTRICTED_BASE, access_level: 'all', role_id: null });
    invalidatePermissionCache();
  }
});

test('integration: missing/deleted files are excluded', async () => {
  // noteC.txt is already in the warmed library cache; delete it so the cached
  // tree still references it but the file no longer exists on disk.
  const victim = `${TEST_BASE}/noteC.txt`;
  const victimAbs = path.join(QUERIES_DIR, victim);
  let res = await http(`/query/${enc(TEST_BASE + '/noteA.txt')}`, { headers: { Cookie: COOKIE } });
  assert.equal(res.status, 200);
  let html = await res.text();
  assert.ok(html.includes(enc(victim)), 'victim should appear while it exists');
  await rm(victimAbs, { force: true });
  try {
    res = await http(`/query/${enc(TEST_BASE + '/noteA.txt')}`, { headers: { Cookie: COOKIE } });
    assert.equal(res.status, 200);
    html = await res.text();
    const section = relatedSection(html);
    assert.ok(section);
    assert.ok(!section.includes(enc(victim)), 'deleted file must be filtered out');
  } finally {
    await writeFile(victimAbs, 'gamma content');
  }
});

test('integration: empty result does not render the section', async () => {
  permRows = [{ folder_path: SOLO_BASE, access_level: 'all', role_id: null }];
  invalidatePermissionCache();
  await new Promise(r => setTimeout(r, 50));
  try {
    const res = await http(`/query/${enc(SOLO_BASE + '/solo.txt')}`, { headers: { Cookie: COOKIE } });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.doesNotMatch(html, /data-testid="related-content"/);
    assert.doesNotMatch(html, /Related Content/);
    // discussions still work on the lonely page
    assert.match(html, /Have a question\?/);
  } finally {
    permRows = [
      { folder_path: 'Guidewire', access_level: 'all', role_id: null },
      { folder_path: 'Tutorials', access_level: 'all', role_id: null },
      { folder_path: 'Videos', access_level: 'all', role_id: null },
      { folder_path: TEST_BASE, access_level: 'all', role_id: null },
      { folder_path: MANY_BASE, access_level: 'all', role_id: null },
      { folder_path: SOLO_BASE, access_level: 'all', role_id: null },
      { folder_path: RESTRICTED_BASE, access_level: 'all', role_id: null }
    ];
    invalidatePermissionCache();
  }
});

test('integration: existing discussions markup still works on all content pages', async () => {
  const q = await http(`/query/${enc(TEST_BASE + '/noteB.txt')}`, { headers: { Cookie: COOKIE } });
  assert.equal(q.status, 200);
  assert.match(await q.text(), /discussion-new-form/);
  const it = await http(`/item/${enc(TEST_BASE + '/doc.pdf')}`, { headers: { Cookie: COOKIE } });
  assert.equal(it.status, 200);
  assert.match(await it.text(), /discussion-new-form/);
  const v = await http(`/watch/${enc('Videos/Finding Rate table & Routine Usages.mp4')}`, { headers: { Cookie: COOKIE } });
  assert.equal(v.status, 200);
  assert.match(await v.text(), /discussion-new-form/);
});
