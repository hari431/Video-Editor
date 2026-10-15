import './helpers/env.js';
process.env.HIDDEN_FOLDERS = 'Internal,Drafts';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookieSignature from 'cookie-signature';
import { pool } from '../src/db/pool.js';
import { contentRouteForPath } from '../src/library/local.js';

const QUERIES_DIR = fileURLToPath(new URL('../queries/', import.meta.url));

const { app } = await import('../src/server.js');
import { markContentSeen, getSeenPaths, getNewContentForUser, MAX_NEW_ITEMS } from '../src/library/new-content.js';

const SID1 = 'newcontent-harness-1';
const SID2 = 'newcontent-harness-2';
const SID3 = 'newcontent-harness-3';
const COOKIE1 = `connect.sid=s:${cookieSignature.sign(SID1, process.env.SESSION_SECRET)}`;
const COOKIE2 = `connect.sid=s:${cookieSignature.sign(SID2, process.env.SESSION_SECRET)}`;
const COOKIE3 = `connect.sid=s:${cookieSignature.sign(SID3, process.env.SESSION_SECRET)}`;

const T0 = Date.now();
const FIRST_LOGIN = new Date(T0);
const FUTURE_LOGIN = new Date(T0 + 3600_000);
const NEW_MTIME = new Date(T0 + 60_000);
const NEW_MTIME2 = new Date(T0 + 70_000);
const OLD_MTIME = new Date(T0 - 86400_000);

const USER1 = {
  id: 201,
  google_user_id: 'google-newcontent-1',
  email: 'newcontent1@example.com',
  name: 'NewContent Tester 1',
  status: 'active',
  first_login_at: FIRST_LOGIN,
  last_login_at: new Date(T0),
  access_expires_at: new Date(Date.now() + 30 * 86400000),
  app_role: 'user'
};
const USER2 = {
  id: 202,
  google_user_id: 'google-newcontent-2',
  email: 'newcontent2@example.com',
  name: 'NewContent Tester 2',
  status: 'active',
  first_login_at: FIRST_LOGIN,
  last_login_at: new Date(T0),
  access_expires_at: new Date(Date.now() + 30 * 86400000),
  app_role: 'user'
};
// New user whose first login is after all test content: sees nothing historical.
const USER3 = {
  id: 203,
  google_user_id: 'google-newcontent-3',
  email: 'newcontent3@example.com',
  name: 'NewContent Newcomer',
  status: 'active',
  first_login_at: FUTURE_LOGIN,
  last_login_at: FUTURE_LOGIN,
  access_expires_at: new Date(Date.now() + 30 * 86400000),
  app_role: 'user'
};

const TEST_BASE = '__new_content_test';
const TEST_NEWFOLDER = '__new_content_newfolder';
const INTERNAL_DIR = 'Internal';

// In-memory stores
const recentStore = new Map(); // userId -> Map(path -> {id,last_viewed_at,created_at})
let recentNextId = 1;
let recentClock = Date.now();
function recentNextTime() { recentClock += 1000; return new Date(recentClock); }
const seenStore = new Map(); // userId -> Set(path)
function getSeenSet(u) { if (!seenStore.has(u)) seenStore.set(u, new Set()); return seenStore.get(u); }
function recentRows(userId) {
  const m = recentStore.get(userId);
  if (!m) return [];
  return [...m.values()].map(v => ({ item_path: v.itemPath, last_viewed_at: v.last_viewed_at, created_at: v.created_at, id: v.id }));
}

let originalQuery = null;
let server = null;
let port = 0;

const enc = value => value.split('/').map(encodeURIComponent).join('/');
const http = (suffix, init) => fetch(`http://127.0.0.1:${port}${suffix}`, init);

async function touch(p, mtime) {
  const abs = path.join(QUERIES_DIR, ...p.split('/'));
  await utimes(abs, mtime, mtime);
}

test.before(async () => {
  // Create test content BEFORE first library load (server caches tree).
  await mkdir(path.join(QUERIES_DIR, TEST_BASE, 'sub'), { recursive: true });
  await mkdir(path.join(QUERIES_DIR, TEST_NEWFOLDER), { recursive: true });
  await mkdir(path.join(QUERIES_DIR, INTERNAL_DIR), { recursive: true });
  await writeFile(path.join(QUERIES_DIR, TEST_BASE, 'note.txt'), 'new txt content');
  await writeFile(path.join(QUERIES_DIR, TEST_BASE, 'doc.pdf'), randomBytes(128));
  await writeFile(path.join(QUERIES_DIR, TEST_BASE, 'sheet.xlsx'), randomBytes(128));
  await writeFile(path.join(QUERIES_DIR, TEST_BASE, 'image.png'), randomBytes(128));
  await writeFile(path.join(QUERIES_DIR, TEST_BASE, 'slides.pptx'), randomBytes(128));
  await writeFile(path.join(QUERIES_DIR, TEST_BASE, 'word.docx'), randomBytes(128));
  await writeFile(path.join(QUERIES_DIR, TEST_BASE, 'archive.zip'), randomBytes(128));
  await writeFile(path.join(QUERIES_DIR, TEST_BASE, 'clip.mp4'), randomBytes(256));
  await writeFile(path.join(QUERIES_DIR, TEST_BASE, 'sub', 'deep.txt'), 'deep existing-folder content');
  await writeFile(path.join(QUERIES_DIR, TEST_NEWFOLDER, 'fresh.txt'), 'brand new folder content');
  await writeFile(path.join(QUERIES_DIR, TEST_BASE, 'old.txt'), 'historical content');
  await writeFile(path.join(QUERIES_DIR, INTERNAL_DIR, '__new_hidden.pdf'), randomBytes(128));
  await writeFile(path.join(QUERIES_DIR, TEST_BASE, 'tempdel.pdf'), randomBytes(128));
  // Bulk files for max-20 test (newest mtimes, staggered)
  for (let i = 0; i < 25; i++) {
    await writeFile(path.join(QUERIES_DIR, TEST_BASE, `bulk${String(i).padStart(2, '0')}.pdf`), randomBytes(64));
  }
  // Set mtimes: regular new files -> NEW_MTIME, old -> OLD_MTIME, hidden -> NEW, bulk -> staggered newest
  for (const f of ['note.txt', 'doc.pdf', 'sheet.xlsx', 'image.png', 'slides.pptx', 'word.docx', 'archive.zip', 'clip.mp4', 'tempdel.pdf']) {
    await touch(`${TEST_BASE}/${f}`, NEW_MTIME);
  }
  await touch(`${TEST_BASE}/sub/deep.txt`, NEW_MTIME);
  await touch(`${TEST_NEWFOLDER}/fresh.txt`, NEW_MTIME2);
  await touch(`${TEST_BASE}/old.txt`, OLD_MTIME);
  await touch(`${INTERNAL_DIR}/__new_hidden.pdf`, NEW_MTIME);
  for (let i = 0; i < 25; i++) {
    await touch(`${TEST_BASE}/bulk${String(i).padStart(2, '0')}.pdf`, new Date(T0 + 120_000 + i * 1000));
  }

  originalQuery = pool.query;
  pool.query = async (sql, params = []) => {
    if (/SELECT to_regclass/.test(sql)) return { rows: [{ to_regclass: 'user_sessions' }] };
    if (/SELECT sess FROM ["']?user_sessions["']?/i.test(sql)) {
      const sid = params[0];
      if (sid === SID1) return { rows: [{ sess: JSON.stringify({ cookie: {}, passport: { user: 201 } }) }] };
      if (sid === SID2) return { rows: [{ sess: JSON.stringify({ cookie: {}, passport: { user: 202 } }) }] };
      if (sid === SID3) return { rows: [{ sess: JSON.stringify({ cookie: {}, passport: { user: 203 } }) }] };
      return { rows: [] };
    }
    if (/SELECT \* FROM users WHERE id = \$1/i.test(sql)) {
      const id = params[0];
      if (id === 201) return { rows: [USER1] };
      if (id === 202) return { rows: [USER2] };
      if (id === 203) return { rows: [USER3] };
      return { rows: [] };
    }
    if (/user_roles/.test(sql)) return { rows: [] };
    if (/folder_permissions/.test(sql)) {
      return {
        rows: [
          { folder_path: 'Videos', access_level: 'all', role_id: null },
          { folder_path: 'Guidewire', access_level: 'all', role_id: null },
          { folder_path: 'Tutorials', access_level: 'all', role_id: null },
          { folder_path: TEST_BASE, access_level: 'all', role_id: null },
          { folder_path: TEST_NEWFOLDER, access_level: 'all', role_id: null }
        ]
      };
    }
    // content_seen
    if (/INSERT INTO content_seen/.test(sql)) {
      getSeenSet(params[0]).add(params[1]);
      return { rows: [] };
    }
    if (/FROM content_seen/.test(sql) && /WHERE user_id/.test(sql)) {
      const set = seenStore.get(params[0]) || new Set();
      return { rows: [...set].map(p => ({ item_path: p })) };
    }
    // recently_viewed
    if (/INSERT INTO recently_viewed/.test(sql)) {
      const userId = params[0]; const itemPath = params[1];
      if (!recentStore.has(userId)) recentStore.set(userId, new Map());
      const m = recentStore.get(userId);
      const now = recentNextTime();
      if (m.has(itemPath)) m.get(itemPath).last_viewed_at = now;
      else m.set(itemPath, { id: recentNextId++, itemPath, last_viewed_at: now, created_at: now });
      return { rows: [] };
    }
    if (/DELETE FROM recently_viewed/.test(sql) && /id NOT IN/.test(sql)) {
      const userId = params[0]; const limit = params[1];
      const m = recentStore.get(userId);
      if (m) {
        const sorted = [...m.values()].sort((a, b) => b.last_viewed_at - a.last_viewed_at);
        const keep = new Set(sorted.slice(0, limit).map(v => v.id));
        for (const [k, v] of [...m.entries()]) if (!keep.has(v.id)) m.delete(k);
      }
      return { rows: [] };
    }
    if (/FROM recently_viewed/.test(sql) && /WHERE user_id/.test(sql) && /ORDER BY last_viewed_at DESC/.test(sql)) {
      const rows = recentRows(params[0]).sort((a, b) => b.last_viewed_at - a.last_viewed_at).slice(0, params[1] ?? 20);
      return { rows };
    }
    if (/item_likes/.test(sql)) {
      if (/COUNT/.test(sql)) return { rows: [{ cnt: '0' }] };
      if (/SELECT id FROM item_likes/.test(sql)) return { rows: [] };
      return { rows: [] };
    }
    if (/video_views/.test(sql)) return { rows: [{ cnt: '0' }] };
    if (/query_usage/.test(sql)) return { rows: [] };
    if (/discussions/.test(sql)) return { rows: [] };
    if (/discussion_replies/.test(sql)) return { rows: [] };
    if (/SELECT COUNT/.test(sql)) return { rows: [{ cnt: '0' }] };
    return { rows: [] };
  };

  server = await new Promise(resolve => {
    const s = app.listen(0, () => resolve(s));
  });
  port = server.address().port;

  // Pre-seed bulk files as seen for USER1/USER2 so most tests are isolated
  // to the small fixture set; the max-20 test clears this seeding.
  for (let i = 0; i < 25; i++) {
    const p = `${TEST_BASE}/bulk${String(i).padStart(2, '0')}.pdf`;
    getSeenSet(201).add(p);
    getSeenSet(202).add(p);
  }
  // tempdel.pdf is used by the missing-content test; keep it unseen initially.
});

test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  if (originalQuery) { pool.query = originalQuery; originalQuery = null; }
  try { await rm(path.join(QUERIES_DIR, TEST_BASE), { recursive: true, force: true }); } catch {}
  try { await rm(path.join(QUERIES_DIR, TEST_NEWFOLDER), { recursive: true, force: true }); } catch {}
  try { await rm(path.join(QUERIES_DIR, INTERNAL_DIR, '__new_hidden.pdf'), { force: true }); } catch {}
  recentStore.clear(); seenStore.clear();
});

test('unauthenticated users cannot access the feature', async () => {
  const res = await http('/my/new-content', { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/login');
  const home = await http('/', { redirect: 'manual' });
  assert.equal(home.status, 200);
});

test('content added after last login appears (banner + list)', async () => {
  const home = await http('/', { headers: { Cookie: COOKIE1 } });
  assert.equal(home.status, 200);
  const html = await home.text();
  assert.match(html, /data-testid="new-content-banner"/);
  assert.match(html, /New content available/);
  assert.match(html, /View New Content/);
  const list = await http('/my/new-content', { headers: { Cookie: COOKIE1 } });
  assert.equal(list.status, 200);
  const listHtml = await list.text();
  assert.match(listHtml, new RegExp(TEST_BASE));
  assert.ok(listHtml.includes('/query/' + enc(`${TEST_BASE}/note.txt`)));
});

test('new folder content works', async () => {
  const list = await http('/my/new-content', { headers: { Cookie: COOKIE1 } });
  const html = await list.text();
  assert.ok(html.includes(enc(`${TEST_NEWFOLDER}/fresh.txt`)), 'new folder file should be listed');
});

test('existing folder content works', async () => {
  const list = await http('/my/new-content', { headers: { Cookie: COOKIE1 } });
  const html = await list.text();
  assert.ok(html.includes(enc(`${TEST_BASE}/sub/deep.txt`)), 'existing folder file should be listed');
});

test('all supported content types use correct existing routes', async () => {
  const list = await http('/my/new-content', { headers: { Cookie: COOKIE1 } });
  const html = await list.text();
  const cases = [
    [`${TEST_BASE}/note.txt`, '/query/'],
    [`${TEST_BASE}/clip.mp4`, '/watch/'],
    [`${TEST_BASE}/doc.pdf`, '/item/'],
    [`${TEST_BASE}/sheet.xlsx`, '/item/'],
    [`${TEST_BASE}/image.png`, '/item/'],
    [`${TEST_BASE}/slides.pptx`, '/item/'],
    [`${TEST_BASE}/word.docx`, '/item/'],
    [`${TEST_BASE}/archive.zip`, '/item/']
  ];
  for (const [p, route] of cases) {
    assert.equal(contentRouteForPath(p), route, `contentRouteForPath(${p})`);
    assert.ok(html.includes(route + enc(p)), `${p} should link via ${route}`);
  }
});

test('list shows title, type, category and added date with correct ordering', async () => {
  const list = await http('/my/new-content', { headers: { Cookie: COOKIE1 } });
  const html = await list.text();
  assert.match(html, /PDF/);
  assert.match(html, new RegExp(TEST_BASE));
  assert.match(html, /\d{1,2}\/\d{1,2}\/\d{4}|\d{4}/);
  // fresh.txt (NEW_MTIME2) is newer than note.txt (NEW_MTIME) so should come first
  const idxFresh = html.indexOf(enc(`${TEST_NEWFOLDER}/fresh.txt`));
  const idxNote = html.indexOf(enc(`${TEST_BASE}/note.txt`));
  assert.ok(idxFresh !== -1 && idxNote !== -1);
  assert.ok(idxFresh < idxNote, 'newest first ordering');
});

test('folders themselves are never shown', async () => {
  const list = await http('/my/new-content', { headers: { Cookie: COOKIE1 } });
  const html = await list.text();
  assert.doesNotMatch(html, /data-path="__new_content_test"/);
  assert.ok(!html.includes('/browse/' + enc(TEST_BASE) + '"') || !html.includes('data-testid="new-content-item" data-path="' + TEST_BASE + '"'));
});

test('restricted content is excluded', async () => {
  const list = await http('/my/new-content', { headers: { Cookie: COOKIE1 } });
  const html = await list.text();
  assert.ok(!html.includes('__new_hidden.pdf'), 'hidden folder content must not leak');
});

test('new user does not receive all historical content', async () => {
  const list = await http('/my/new-content', { headers: { Cookie: COOKIE3 } });
  assert.equal(list.status, 200);
  const html = await list.text();
  assert.ok(!html.includes(enc(`${TEST_BASE}/note.txt`)), 'historical content must not show for brand-new user');
  assert.match(html, /data-testid="new-content-empty"/);
  const home = await http('/', { headers: { Cookie: COOKIE3 } });
  const homeHtml = await home.text();
  assert.doesNotMatch(homeHtml, /data-testid="new-content-banner"/);
});

test('content added after first login is eligible; historical is not', async () => {
  // old.txt has mtime before USER1.first_login_at -> excluded for USER1
  const list = await http('/my/new-content', { headers: { Cookie: COOKIE1 } });
  const html = await list.text();
  assert.ok(!html.includes(enc(`${TEST_BASE}/old.txt`)), 'pre-first-login content excluded');
  assert.ok(html.includes(enc(`${TEST_BASE}/note.txt`)), 'post-first-login content eligible');
});

test('opening content marks it seen; seen disappears from future notifications', async () => {
  const p = `${TEST_BASE}/note.txt`;
  // sanity: visible before open
  let list = await http('/my/new-content', { headers: { Cookie: COOKIE1 } });
  assert.ok((await list.text()).includes(enc(p)));
  // viewing the new-content LIST must not mark seen
  list = await http('/my/new-content', { headers: { Cookie: COOKIE1 } });
  assert.ok((await list.text()).includes(enc(p)), 'list view alone must not clear');
  // banner display must not mark seen either (home already fetched above, still present)
  const home = await http('/', { headers: { Cookie: COOKIE1 } });
  assert.match(await home.text(), /data-testid="new-content-banner"/);
  // actual open marks seen
  const open = await http('/query/' + enc(p), { headers: { Cookie: COOKIE1 } });
  assert.equal(open.status, 200);
  assert.ok(getSeenSet(201).has(p), 'open should record seen');
  list = await http('/my/new-content', { headers: { Cookie: COOKIE1 } });
  assert.ok(!(await list.text()).includes(enc(p)), 'seen item must disappear');
});

test('missed content remains visible across subsequent logins until opened', async () => {
  const p = `${TEST_BASE}/doc.pdf`;
  assert.ok(getSeenSet(201).has(`${TEST_BASE}/note.txt`), 'precondition: note seen');
  // Simulate a later login after the content mtime without opening it.
  // Home only shows the banner (not individual paths), so assert the banner
  // persists and the list still contains the unopened item.
  USER1.last_login_at = new Date(T0 + 500_000);
  const home = await http('/', { headers: { Cookie: COOKIE1 } });
  assert.equal(home.status, 200);
  assert.match(await home.text(), /data-testid="new-content-banner"/, 'banner must persist after later login without opening');
  const list = await http('/my/new-content', { headers: { Cookie: COOKIE1 } });
  assert.ok((await list.text()).includes(enc(p)), 'unopened item must remain after later login');
  USER1.last_login_at = new Date(T0);
});

test('different users have independent seen state', async () => {
  const p = `${TEST_BASE}/sheet.xlsx`;
  // USER1 opens it
  const open = await http('/item/' + enc(p), { headers: { Cookie: COOKIE1 } });
  assert.equal(open.status, 200);
  assert.ok(getSeenSet(201).has(p));
  assert.ok(!getSeenSet(202).has(p));
  // USER1 no longer sees it, USER2 still does
  const list1 = await http('/my/new-content', { headers: { Cookie: COOKIE1 } });
  assert.ok(!(await list1.text()).includes(enc(p)));
  const list2 = await http('/my/new-content', { headers: { Cookie: COOKIE2 } });
  assert.ok((await list2.text()).includes(enc(p)), 'other user still sees item');
});

test('missing/deleted content is excluded', async () => {
  const p = `${TEST_BASE}/tempdel.pdf`;
  let list = await http('/my/new-content', { headers: { Cookie: COOKIE2 } });
  assert.ok((await list.text()).includes(enc(p)), 'precondition: temp file visible');
  await rm(path.join(QUERIES_DIR, ...p.split('/')), { force: true });
  // Cached tree still holds the stale path, but stat fails -> excluded
  list = await http('/my/new-content', { headers: { Cookie: COOKIE2 } });
  assert.ok(!(await list.text()).includes(enc(p)), 'deleted file must be excluded');
});

test('maximum 20 items, newest first', async () => {
  assert.equal(MAX_NEW_ITEMS, 20);
  seenStore.get(201)?.clear();
  seenStore.get(202)?.clear();
  // Re-add non-bulk seen? No: bulk mtimes are newest so top-20 are bulk newest 20 regardless.
  const list = await http('/my/new-content', { headers: { Cookie: COOKIE1 } });
  const html = await list.text();
  const matches = html.match(/data-testid="new-content-item"/g) || [];
  assert.equal(matches.length, 20, 'list caps at 20');
  for (let i = 0; i < 5; i++) {
    assert.ok(!html.includes(enc(`${TEST_BASE}/bulk${String(i).padStart(2, '0')}.pdf`)), `bulk${i} evicted`);
  }
  for (let i = 20; i < 25; i++) {
    assert.ok(html.includes(enc(`${TEST_BASE}/bulk${String(i).padStart(2, '0')}.pdf`)));
  }
  const idx24 = html.indexOf(enc(`${TEST_BASE}/bulk24.pdf`));
  const idx20 = html.indexOf(enc(`${TEST_BASE}/bulk20.pdf`));
  assert.ok(idx24 < idx20, 'newest first');
});

test('empty state: banner hidden when nothing is new', async () => {
  // Mark everything under TEST_BASE/TEST_NEWFOLDER seen for USER2 (bulk already cleared above; re-add all)
  // Simplest: mark all currently listed items seen by opening them is slow; directly seed store.
  const list = await http('/my/new-content', { headers: { Cookie: COOKIE2 } });
  const html = await list.text();
  const paths = [...html.matchAll(/data-path="([^"]+)"/g)].map(m => m[1]);
  for (const p of paths) getSeenSet(202).add(p);
  // Also seed remaining fixtures explicitly
  for (const f of ['note.txt', 'doc.pdf', 'sheet.xlsx', 'image.png', 'slides.pptx', 'word.docx', 'archive.zip', 'clip.mp4']) {
    getSeenSet(202).add(`${TEST_BASE}/${f}`);
  }
  getSeenSet(202).add(`${TEST_BASE}/sub/deep.txt`);
  getSeenSet(202).add(`${TEST_NEWFOLDER}/fresh.txt`);
  for (let i = 0; i < 25; i++) getSeenSet(202).add(`${TEST_BASE}/bulk${String(i).padStart(2, '0')}.pdf`);
  const home = await http('/', { headers: { Cookie: COOKIE2 } });
  assert.doesNotMatch(await home.text(), /data-testid="new-content-banner"/);
  const emptyList = await http('/my/new-content', { headers: { Cookie: COOKIE2 } });
  assert.match(await emptyList.text(), /data-testid="new-content-empty"/);
});

test('existing Recently Viewed behavior still works alongside seen tracking', async () => {
  recentStore.clear();
  const p = `${TEST_BASE}/image.png`;
  const open = await http('/item/' + enc(p), { headers: { Cookie: COOKIE1 } });
  assert.equal(open.status, 200);
  const rows = recentRows(201);
  assert.ok(rows.some(r => r.item_path === p), 'recently viewed still records');
  assert.ok(getSeenSet(201).has(p), 'seen also records');
  const home = await http('/', { headers: { Cookie: COOKIE1 } });
  const html = await home.text();
  assert.match(html, /Recently Viewed/);
});

test('direct module API: markContentSeen/getSeenPaths/getNewContentForUser', async () => {
  const rows = await getSeenPaths(201);
  assert.ok(rows instanceof Set);
  await markContentSeen(201, `${TEST_BASE}/direct-probe.txt`);
  assert.ok((await getSeenPaths(201)).has(`${TEST_BASE}/direct-probe.txt`));
  await markContentSeen(null, 'x');
  await markContentSeen(201, '   ');
  assert.deepEqual(await getNewContentForUser(null, null), []);
  assert.deepEqual(await getNewContentForUser({ id: 0 }, null), []);
});

test('home shows New Content banner, browse/query/watch/item do NOT (home-only banner)', async () => {
  // ensure home has eligible content (re-seed if needed)
  // clear seen for USER1 to guarantee banner
  seenStore.get(201)?.clear();
  for (let i = 0; i < 25; i++) {
    // re-add bulk as not seen? For this test we want some new content, so clear all seen
  }
  // Home should show banner when eligible
  const homeRes = await http('/', { headers: { Cookie: COOKIE1 } });
  const homeHtml = await homeRes.text();
  assert.equal(homeRes.status, 200);
  assert.match(homeHtml, /data-testid="new-content-banner"/, 'home should show New Content banner when eligible');

  // Browse should NOT
  const browseRes = await http(`/browse/${enc(TEST_BASE)}`, { headers: { Cookie: COOKIE1 } });
  const browseHtml = await browseRes.text();
  assert.equal(browseRes.status, 200);
  assert.doesNotMatch(browseHtml, /data-testid="new-content-banner"/, 'browse should NOT show banner');

  // Query page should NOT
  const queryRes = await http(`/query/${enc(`${TEST_BASE}/note.txt`)}`, { headers: { Cookie: COOKIE1 } });
  const queryHtml = await queryRes.text();
  assert.equal(queryRes.status, 200);
  assert.doesNotMatch(queryHtml, /data-testid="new-content-banner"/, 'query should NOT show banner');

  // Video page should NOT
  const watchRes = await http(`/watch/${enc(`${TEST_BASE}/clip.mp4`)}`, { headers: { Cookie: COOKIE1 } });
  const watchHtml = await watchRes.text();
  assert.equal(watchRes.status, 200);
  assert.doesNotMatch(watchHtml, /data-testid="new-content-banner"/, 'video should NOT show banner');

  // Item page should NOT
  const itemRes = await http(`/item/${enc(`${TEST_BASE}/doc.pdf`)}`, { headers: { Cookie: COOKIE1 } });
  const itemHtml = await itemRes.text();
  assert.equal(itemRes.status, 200);
  assert.doesNotMatch(itemHtml, /data-testid="new-content-banner"/, 'item should NOT show banner');

  // /my/new-content still works and shows list
  const listRes = await http('/my/new-content', { headers: { Cookie: COOKIE1 } });
  const listHtml = await listRes.text();
  assert.equal(listRes.status, 200);
  assert.match(listHtml, /data-testid="new-content-list"/, '/my/new-content should still show list');
});
