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
import { contentRouteForPath, getTypeDisplayName } from '../src/library/local.js';
import { getFileTypeFromFilename } from '../src/library/file-types.js';

const QUERIES_DIR = fileURLToPath(new URL('../queries/', import.meta.url));
const VIEWS_DIR = fileURLToPath(new URL('../src/views/', import.meta.url));

const { app } = await import('../src/server.js');
import { recordRecentlyViewed, getRecentlyViewed, MAX_HISTORY } from '../src/library/recently-viewed.js';

const SID1 = 'recently-harness-1';
const SID2 = 'recently-harness-2';
const COOKIE1 = `connect.sid=s:${cookieSignature.sign(SID1, process.env.SESSION_SECRET)}`;
const COOKIE2 = `connect.sid=s:${cookieSignature.sign(SID2, process.env.SESSION_SECRET)}`;

const USER1 = {
  id: 101,
  google_user_id: 'google-recently-1',
  email: 'recently1@example.com',
  name: 'Recently Tester 1',
  status: 'active',
  first_login_at: new Date(),
  last_login_at: new Date(),
  access_expires_at: new Date(Date.now() + 30 * 86400000),
  app_role: 'user'
};
const USER2 = {
  id: 102,
  google_user_id: 'google-recently-2',
  email: 'recently2@example.com',
  name: 'Recently Tester 2',
  status: 'active',
  first_login_at: new Date(),
  last_login_at: new Date(),
  access_expires_at: new Date(Date.now() + 30 * 86400000),
  app_role: 'user'
};

// In-memory store for recently_viewed: Map<userId, Map<itemPath, {id, last_viewed_at, created_at}>>
const store = new Map();
let nextId = 1;
let timeCounter = Date.now();
function nextTime() { timeCounter += 1000; return new Date(timeCounter); }

// In-memory store for content_seen (for New Content unaffected check)
const seenStore = new Map();
function getSeenSet(u) { if (!seenStore.has(u)) seenStore.set(u, new Set()); return seenStore.get(u); }

const TEST_BASE = '__recently_viewed_test';

let originalQuery = null;
let server = null;
let port = 0;

function getStoreRows(userId) {
  const m = store.get(userId);
  if (!m) return [];
  return [...m.values()].map(v => ({ item_path: v.itemPath, last_viewed_at: v.last_viewed_at, created_at: v.created_at, id: v.id }));
}

test.before(async () => {
  // create test files for various types
  const base = path.join(QUERIES_DIR, TEST_BASE);
  await mkdir(base, { recursive: true });
  await writeFile(path.join(base, 'note.txt'), 'hello txt content');
  await writeFile(path.join(base, 'doc.pdf'), randomBytes(128));
  await writeFile(path.join(base, 'sheet.xlsx'), randomBytes(128));
  await writeFile(path.join(base, 'image.png'), randomBytes(128));
  await writeFile(path.join(base, 'archive.zip'), randomBytes(128));
  await writeFile(path.join(base, 'slides.pptx'), randomBytes(128));
  await writeFile(path.join(base, 'word.docx'), randomBytes(128));
  // Also create a subfolder file for traversal test not needed
  await mkdir(path.join(base, 'sub'), { recursive: true });
  await writeFile(path.join(base, 'sub', 'deep.txt'), 'deep content');

  // Use Tutorials video which already exists; no need to create Videos folder

  originalQuery = pool.query;
  pool.query = async (sql, params = []) => {
    if (/SELECT to_regclass/.test(sql)) return { rows: [{ to_regclass: 'user_sessions' }] };
    if (/SELECT sess FROM ["']?user_sessions["']?/i.test(sql)) {
      // Determine which SID is in cookie parsing would be done by session store; we simulate by checking params? Actually connect-pg-simple does SELECT sess FROM "user_sessions" WHERE sid = $1
      // params[0] is SID
      const sid = params[0];
      if (sid === SID1) return { rows: [{ sess: JSON.stringify({ cookie: {}, passport: { user: 101 } }) }] };
      if (sid === SID2) return { rows: [{ sess: JSON.stringify({ cookie: {}, passport: { user: 102 } }) }] };
      return { rows: [] };
    }
    if (/SELECT \* FROM users WHERE id = \$1/i.test(sql)) {
      const id = params[0];
      if (id === 101) return { rows: [USER1] };
      if (id === 102) return { rows: [USER2] };
      return { rows: [] };
    }
    if (/user_roles/.test(sql)) return { rows: [] };
    if (/folder_permissions/.test(sql)) {
      return {
        rows: [
          { folder_path: 'Videos', access_level: 'all', role_id: null },
          { folder_path: 'Guidewire', access_level: 'all', role_id: null },
          { folder_path: TEST_BASE, access_level: 'all', role_id: null },
          { folder_path: 'Tutorials', access_level: 'all', role_id: null }
        ]
      };
    }
    // content_seen handling (for New Content unaffected check)
    if (/INSERT INTO content_seen/.test(sql)) {
      getSeenSet(params[0]).add(params[1]);
      return { rows: [] };
    }
    if (/FROM content_seen/.test(sql) && /WHERE user_id/.test(sql)) {
      const set = seenStore.get(params[0]) || new Set();
      if (/item_path,\s*status/i.test(sql)) {
        return { rows: [...set].map(item_path => ({ item_path, status: 'seen' })) };
      }
      return { rows: [...set].map(item_path => ({ item_path })) };
    }
    // recently_viewed handling
    if (/INSERT INTO recently_viewed/.test(sql)) {
      const userId = params[0];
      const itemPath = params[1];
      if (!store.has(userId)) store.set(userId, new Map());
      const m = store.get(userId);
      const now = nextTime();
      if (m.has(itemPath)) {
        const existing = m.get(itemPath);
        existing.last_viewed_at = now;
      } else {
        m.set(itemPath, { id: nextId++, itemPath, last_viewed_at: now, created_at: now });
      }
      return { rows: [] };
    }
    if (/DELETE FROM recently_viewed/.test(sql) && /id NOT IN/.test(sql)) {
      const userId = params[0];
      const limit = params[1];
      const m = store.get(userId);
      if (!m) return { rows: [] };
      // keep most recent limit
      const sorted = [...m.values()].sort((a,b) => b.last_viewed_at - a.last_viewed_at);
      const keepIds = new Set(sorted.slice(0, limit).map(v => v.id));
      for (const [k,v] of [...m.entries()]) {
        if (!keepIds.has(v.id)) m.delete(k);
      }
      return { rows: [] };
    }
    if (/DELETE FROM recently_viewed/.test(sql) && /WHERE user_id/.test(sql)) {
      const userId = params[0];
      const m = store.get(userId);
      if (m) m.clear();
      return { rows: [] };
    }
    if (/FROM recently_viewed/.test(sql) && /WHERE user_id/.test(sql) && /ORDER BY last_viewed_at DESC/.test(sql)) {
      const userId = params[0];
      const limit = params[1] ?? 20;
      const rows = getStoreRows(userId).sort((a,b) => b.last_viewed_at - a.last_viewed_at).slice(0, limit);
      return { rows };
    }
    // item_likes, video_views, query_usage, discussions etc - return empty
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
    // For library page admin stats etc not needed
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
  // cleanup
  try { await rm(path.join(QUERIES_DIR, TEST_BASE), { recursive: true, force: true }); } catch {}
  store.clear();
  seenStore.clear();
});

const enc = value => value.split('/').map(encodeURIComponent).join('/');
const http = (suffix, init) => fetch(`http://127.0.0.1:${port}${suffix}`, init);

test('unauthenticated cannot create or read recently viewed history', async () => {
  const unauthQuery = await http('/query/Guidewire/Gosu/PC/Rating/Partial%20worksheet%20print.txt', { redirect: 'manual' });
  assert.equal(unauthQuery.status, 302);
  assert.equal(unauthQuery.headers.get('location'), '/login');

  const unauthWatch = await http('/watch/Videos/Finding%20Rate%20table%20%26%20Routine%20Usages.mp4', { redirect: 'manual' });
  assert.equal(unauthWatch.status, 302);

  const unauthItem = await http(`/item/${enc(TEST_BASE + '/doc.pdf')}`, { redirect: 'manual' });
  assert.equal(unauthItem.status, 302);

  const unauthHome = await http('/', { redirect: 'manual' });
  assert.equal(unauthHome.status, 200);

  // store should remain empty for unauth
  assert.equal((store.get(101)?.size ?? 0), 0);
});

test('first view creates a record', async () => {
  store.clear();
  const p = 'Guidewire/Gosu/PC/Rating/Partial worksheet print.txt';
  const res = await http(`/query/${enc(p)}`, { headers: { Cookie: COOKIE1 } });
  assert.equal(res.status, 200);
  // allow async record to settle (we await in handler, but ensure)
  await new Promise(r => setTimeout(r, 50));
  const rows = getStoreRows(101);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].item_path, p);
});

test('viewing same item updates timestamp rather than duplicates', async () => {
  store.clear();
  const p = 'Guidewire/Gosu/PC/Rating/Partial worksheet print.txt';
  await http(`/query/${enc(p)}`, { headers: { Cookie: COOKIE1 } });
  await new Promise(r => setTimeout(r, 10));
  const firstTime = getStoreRows(101)[0].last_viewed_at;
  await new Promise(r => setTimeout(r, 10));
  await http(`/query/${enc(p)}`, { headers: { Cookie: COOKIE1 } });
  await new Promise(r => setTimeout(r, 10));
  const rows = getStoreRows(101);
  assert.equal(rows.length, 1, 'should not duplicate');
  assert.ok(rows[0].last_viewed_at > firstTime, 'timestamp should be updated');
});

test('different users have isolated histories', async () => {
  store.clear();
  const p1 = 'Guidewire/Gosu/PC/Rating/Partial worksheet print.txt';
  const p2 = `${TEST_BASE}/doc.pdf`;
  await http(`/query/${enc(p1)}`, { headers: { Cookie: COOKIE1 } });
  await http(`/item/${enc(p2)}`, { headers: { Cookie: COOKIE2 } });
  await new Promise(r => setTimeout(r, 20));
  const rows1 = getStoreRows(101);
  const rows2 = getStoreRows(102);
  assert.equal(rows1.length, 1);
  assert.equal(rows1[0].item_path, p1);
  assert.equal(rows2.length, 1);
  assert.equal(rows2[0].item_path, p2);
  // ensure user1 home does not show user2's item in Recently Viewed
  // (Home may still contain doc.pdf via New Content banner hidden inputs — strip banner before checking)
  const home1 = await http('/', { headers: { Cookie: COOKIE1 } });
  const html1 = await home1.text();
  assert.match(html1, /Partial worksheet print/);
  const html1WithoutBanner = html1.replace(/<section class="new-content-banner"[\s\S]*?<\/section>/, '');
  assert.doesNotMatch(html1WithoutBanner, /doc\.pdf/);
  const home2 = await http('/', { headers: { Cookie: COOKIE2 } });
  const html2 = await home2.text();
  // user2 should see doc but not user1's text file? check
  assert.match(html2, /doc/);
});

test('maximum history is enforced (20)', async () => {
  store.clear();
  const base = path.join(QUERIES_DIR, TEST_BASE);
  for (let i = 0; i < 25; i++) {
    const fp = path.join(base, `file${i}.pdf`);
    await writeFile(fp, randomBytes(64));
  }
  for (let i = 0; i < 25; i++) {
    const p = `${TEST_BASE}/file${i}.pdf`;
    await http(`/item/${enc(p)}`, { headers: { Cookie: COOKIE1 } });
  }
  await new Promise(r => setTimeout(r, 50));
  const rows = getStoreRows(101);
  assert.equal(rows.length, 20, 'should keep only 20 most recent');
  const paths = new Set(rows.map(r => r.item_path));
  for (let i = 0; i < 5; i++) assert.ok(!paths.has(`${TEST_BASE}/file${i}.pdf`), `file${i} should have been evicted`);
  for (let i = 20; i < 25; i++) assert.ok(paths.has(`${TEST_BASE}/file${i}.pdf`));
  for (let i = 0; i < 25; i++) {
    try { await rm(path.join(base, `file${i}.pdf`), { force: true }); } catch {}
  }
});

test('correct ordering descending by last viewed time', async () => {
  store.clear();
  const a = 'Guidewire/Gosu/PC/Rating/Partial worksheet print.txt';
  const b = `${TEST_BASE}/doc.pdf`;
  const c = `${TEST_BASE}/sheet.xlsx`;
  await http(`/query/${enc(a)}`, { headers: { Cookie: COOKIE1 } });
  await new Promise(r => setTimeout(r, 10));
  await http(`/item/${enc(b)}`, { headers: { Cookie: COOKIE1 } });
  await new Promise(r => setTimeout(r, 10));
  await http(`/item/${enc(c)}`, { headers: { Cookie: COOKIE1 } });
  await new Promise(r => setTimeout(r, 20));
  let rows = getStoreRows(101).sort((x,y) => y.last_viewed_at - x.last_viewed_at);
  assert.deepEqual(rows.map(r=>r.item_path), [c,b,a]);
  // re-view a, should become first
  await http(`/query/${enc(a)}`, { headers: { Cookie: COOKIE1 } });
  await new Promise(r => setTimeout(r, 20));
  rows = getStoreRows(101).sort((x,y) => y.last_viewed_at - x.last_viewed_at);
  assert.deepEqual(rows.map(r=>r.item_path), [a,c,b]);
  // also check HTML ordering via hrefs
  const home = await http('/', { headers: { Cookie: COOKIE1 } });
  const html = await home.text();
  const hrefA = '/query/' + enc(a);
  const hrefC = '/item/' + enc(c);
  const hrefB = '/item/' + enc(b);
  const idxA = html.indexOf(hrefA);
  const idxC = html.indexOf(hrefC);
  const idxB = html.indexOf(hrefB);
  assert.ok(idxA !== -1 && idxC !== -1 && idxB !== -1, 'all hrefs should be present');
  assert.ok(idxA < idxC && idxC < idxB, 'HTML should be in descending order a,c,b');
});

test('unsupported/missing content is handled safely', async () => {
  store.clear();
  const missing = `${TEST_BASE}/does-not-exist.pdf`;
  const resMissing = await http(`/item/${enc(missing)}`, { headers: { Cookie: COOKIE1 } });
  assert.equal(resMissing.status, 404);
  assert.equal(getStoreRows(101).length, 0, 'missing should not create record');

  const traversal = await http('/item/..%2F..%2FWindows%2Fwin.ini', { headers: { Cookie: COOKIE1 } });
  assert.equal(traversal.status, 400);
  assert.equal(getStoreRows(101).length, 0);

  // unsupported type: create .exe file which is not in registry
  const base = path.join(QUERIES_DIR, TEST_BASE);
  await writeFile(path.join(base, 'bad.exe'), randomBytes(64));
  const unsupp = await http(`/item/${enc(TEST_BASE + '/bad.exe')}`, { headers: { Cookie: COOKIE1 } });
  assert.equal(unsupp.status, 404);
  assert.equal(getStoreRows(101).length, 0);
  await rm(path.join(base, 'bad.exe'), { force: true });

  // folder path should not be tracked - browsing folder
  const browse = await http(`/browse/${enc(TEST_BASE)}`, { headers: { Cookie: COOKIE1 } });
  assert.equal(browse.status, 200);
  assert.equal(getStoreRows(101).length, 0, 'folder browse should not create record');
});

test('all supported content types use correct existing route', async () => {
  store.clear();
  const cases = [
    { path: 'Guidewire/Gosu/PC/Rating/Partial worksheet print.txt', expectedRoute: '/query/' },
    { path: 'Videos/Finding Rate table & Routine Usages.mp4', expectedRoute: '/watch/' },
    { path: `${TEST_BASE}/doc.pdf`, expectedRoute: '/item/' },
    { path: `${TEST_BASE}/sheet.xlsx`, expectedRoute: '/item/' },
    { path: `${TEST_BASE}/image.png`, expectedRoute: '/item/' },
    { path: `${TEST_BASE}/archive.zip`, expectedRoute: '/item/' },
    { path: `${TEST_BASE}/slides.pptx`, expectedRoute: '/item/' },
    { path: `${TEST_BASE}/word.docx`, expectedRoute: '/item/' },
  ];
  for (const { path: p } of cases) {
    const route = contentRouteForPath(p);
    // ensure our server will serve it and record
    const url = route + enc(p);
    const res = await http(url, { headers: { Cookie: COOKIE1 } });
    assert.equal(res.status, 200, `should serve ${p} at ${url}`);
  }
  await new Promise(r => setTimeout(r, 50));
  const home = await http('/', { headers: { Cookie: COOKIE1 } });
  const html = await home.text();
  for (const { path: p, expectedRoute } of cases) {
    const href = expectedRoute + enc(p);
    assert.ok(html.includes(href), `recently viewed should link ${p} via ${expectedRoute}`);
    // also verify contentRouteForPath matches expected
    assert.equal(contentRouteForPath(p), expectedRoute);
  }
});

test('recently viewed section only shown when has content', async () => {
  store.clear();
  const emptyHome = await http('/', { headers: { Cookie: COOKIE1 } });
  const emptyHtml = await emptyHome.text();
  assert.doesNotMatch(emptyHtml, /Recently Viewed/);

  await http(`/query/${enc('Guidewire/Gosu/PC/Rating/Partial worksheet print.txt')}`, { headers: { Cookie: COOKIE1 } });
  await new Promise(r => setTimeout(r, 20));
  const filledHome = await http('/', { headers: { Cookie: COOKIE1 } });
  const filledHtml = await filledHome.text();
  assert.match(filledHtml, /Recently Viewed/);
  // check that each item shows title, type, category and timestamp
  assert.match(filledHtml, /Text/);
  assert.match(filledHtml, /Guidewire/);
});

test('home page displays Recently Viewed when history exists, non-home pages do NOT', async () => {
  store.clear();
  await http(`/query/${enc('Guidewire/Gosu/PC/Rating/Partial worksheet print.txt')}`, { headers: { Cookie: COOKIE1 } });
  await new Promise(r => setTimeout(r, 20));
  // Home should show
  const home = await http('/', { headers: { Cookie: COOKIE1 } });
  assert.match(await home.text(), /Recently Viewed/, 'home should display Recently Viewed');
  // Browse/folder page should NOT
  const browse = await http(`/browse/${enc(TEST_BASE)}`, { headers: { Cookie: COOKIE1 } });
  assert.doesNotMatch(await browse.text(), /Recently Viewed/, 'browse should NOT display Recently Viewed');
  const browseRoot = await http(`/browse/${enc('Guidewire/Gosu')}`, { headers: { Cookie: COOKIE1 } });
  assert.doesNotMatch(await browseRoot.text(), /Recently Viewed/, 'nested browse should NOT display Recently Viewed');
  // Query page should NOT
  const query = await http(`/query/${enc('Guidewire/Gosu/PC/Rating/Partial worksheet print.txt')}`, { headers: { Cookie: COOKIE1 } });
  assert.doesNotMatch(await query.text(), /Recently Viewed/, 'query page should NOT display Recently Viewed');
  // Video page should NOT
  const watch = await http(`/watch/${enc('Videos/Finding Rate table & Routine Usages.mp4')}`, { headers: { Cookie: COOKIE1 } });
  assert.doesNotMatch(await watch.text(), /Recently Viewed/, 'video page should NOT display Recently Viewed');
  // Item page should NOT
  const item = await http(`/item/${enc(TEST_BASE + '/doc.pdf')}`, { headers: { Cookie: COOKIE1 } });
  assert.doesNotMatch(await item.text(), /Recently Viewed/, 'item page should NOT display Recently Viewed');
});

test('display includes content title/name, type, category and last viewed time', async () => {
  store.clear();
  await http(`/item/${enc(TEST_BASE + '/doc.pdf')}`, { headers: { Cookie: COOKIE1 } });
  await new Promise(r => setTimeout(r, 20));
  const home = await http('/', { headers: { Cookie: COOKIE1 } });
  const html = await home.text();
  assert.match(html, /doc/); // title
  assert.match(html, /PDF/); // type label
  assert.match(html, new RegExp(TEST_BASE)); // category includes folder
  // last viewed time locale string includes year or time
  assert.match(html, /\d{1,2}\/\d{1,2}\/\d{4}|\d{4}/);
});

test('module level MAX_HISTORY is 20 and enforces via direct API', async () => {
  assert.equal(MAX_HISTORY, 20);
  store.clear();
  // directly use recordRecentlyViewed 25 times
  for (let i = 0; i < 25; i++) {
    await recordRecentlyViewed(101, `${TEST_BASE}/direct${i}.txt`);
  }
  const rows = await getRecentlyViewed(101);
  assert.equal(rows.length, 20);
  // create files for those direct paths so enriched would filter? but direct API test just checks module
});

// Security: no admin exposure – ensure recently_viewed not returned via admin endpoint
test('admin routes do not expose recently viewed history', async () => {
  store.clear();
  await http(`/query/${enc('Guidewire/Gosu/PC/Rating/Partial worksheet print.txt')}`, { headers: { Cookie: COOKIE1 } });
  await new Promise(r => setTimeout(r, 20));
  // try to fetch admin page as user1 (non-admin would be 403 anyway, but our USER1 is not admin)
  // So admin endpoint should be 403 and not leak data
  const adminRes = await http('/admin', { headers: { Cookie: COOKIE1 } });
  assert.equal(adminRes.status, 403);
  const adminLikes = await http(`/admin/likes/${enc('Guidewire/Gosu/PC/Rating/Partial worksheet print.txt')}`, { headers: { Cookie: COOKIE1 } });
  // non-admin should be 403
  assert.equal(adminLikes.status, 403);
});

test('home shows Clear action when history exists', async () => {
  store.clear();
  await http(`/query/${enc('Guidewire/Gosu/PC/Rating/Partial worksheet print.txt')}`, { headers: { Cookie: COOKIE1 } });
  await new Promise(r => setTimeout(r, 20));
  const home = await http('/', { headers: { Cookie: COOKIE1 } });
  const html = await home.text();
  assert.match(html, /Recently Viewed/, 'should show section');
  assert.match(html, /data-testid="clear-recently-viewed"/, 'should show Clear button');
  assert.match(html, /Clear/, 'Clear text present');
  // form action should be correct
  assert.match(html, /action="\/my\/recently-viewed\/clear"/);
});

test('Clear deletes all rows, redirects to Home, section disappears, other user untouched', async () => {
  store.clear();
  seenStore.clear();
  // seed both users
  await http(`/query/${enc('Guidewire/Gosu/PC/Rating/Partial worksheet print.txt')}`, { headers: { Cookie: COOKIE1 } });
  await http(`/item/${enc(TEST_BASE + '/doc.pdf')}`, { headers: { Cookie: COOKIE2 } });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(getStoreRows(101).length, 1);
  assert.equal(getStoreRows(102).length, 1);
  // also seed New Content seen for user1 to verify unaffected
  getSeenSet(101).add(`${TEST_BASE}/note.txt`);
  const seenBefore = new Set(getSeenSet(101));

  const clearRes = await http('/my/recently-viewed/clear', { method: 'POST', headers: { Cookie: COOKIE1 }, redirect: 'manual' });
  assert.equal(clearRes.status, 302, 'Clear should redirect');
  assert.equal(clearRes.headers.get('location'), '/', 'should redirect to Home');
  assert.equal(getStoreRows(101).length, 0, 'current user cleared');
  assert.equal(getStoreRows(102).length, 1, 'other user untouched');
  // New Content unaffected
  assert.deepEqual(getSeenSet(101), seenBefore, 'New Content ignored state unaffected');

  const homeAfter = await http('/', { headers: { Cookie: COOKIE1 } });
  const htmlAfter = await homeAfter.text();
  assert.doesNotMatch(htmlAfter, /Recently Viewed/, 'section should disappear when empty');
  assert.doesNotMatch(htmlAfter, /data-testid="clear-recently-viewed"/, 'Clear button hidden when empty');
});

test('opening content after clearing creates new entry and appears again; Clear can be used repeatedly', async () => {
  store.clear();
  // first view
  await http(`/query/${enc('Guidewire/Gosu/PC/Rating/Partial worksheet print.txt')}`, { headers: { Cookie: COOKIE1 } });
  await new Promise(r => setTimeout(r, 20));
  let home = await http('/', { headers: { Cookie: COOKIE1 } });
  assert.match(await home.text(), /Recently Viewed/, 'appears after first view');

  // first clear
  let clear = await http('/my/recently-viewed/clear', { method: 'POST', headers: { Cookie: COOKIE1 }, redirect: 'manual' });
  assert.equal(clear.status, 302);
  assert.equal(getStoreRows(101).length, 0);
  home = await http('/', { headers: { Cookie: COOKIE1 } });
  assert.doesNotMatch(await home.text(), /Recently Viewed/, 'disappears after first clear');

  // second view
  await http(`/item/${enc(TEST_BASE + '/sheet.xlsx')}`, { headers: { Cookie: COOKIE1 } });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(getStoreRows(101).length, 1);
  assert.equal(getStoreRows(101)[0].item_path, `${TEST_BASE}/sheet.xlsx`);
  home = await http('/', { headers: { Cookie: COOKIE1 } });
  const homeHtml2 = await home.text();
  assert.match(homeHtml2, /Recently Viewed/, 'appears again after second view');
  assert.match(homeHtml2, /sheet/, 'new item appears');

  // second clear
  clear = await http('/my/recently-viewed/clear', { method: 'POST', headers: { Cookie: COOKIE1 }, redirect: 'manual' });
  assert.equal(clear.status, 302);
  assert.equal(getStoreRows(101).length, 0);
  home = await http('/', { headers: { Cookie: COOKIE1 } });
  assert.doesNotMatch(await home.text(), /Recently Viewed/, 'disappears after second clear');
});

test('unauthenticated users cannot invoke Clear', async () => {
  store.clear();
  await http(`/query/${enc('Guidewire/Gosu/PC/Rating/Partial worksheet print.txt')}`, { headers: { Cookie: COOKIE1 } });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(getStoreRows(101).length, 1);
  const res = await http('/my/recently-viewed/clear', { method: 'POST', redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/login');
  assert.equal(getStoreRows(101).length, 1, 'unauth clear should not delete');
});

test('forged/missing origin is rejected for Clear', async () => {
  store.clear();
  await http(`/query/${enc('Guidewire/Gosu/PC/Rating/Partial worksheet print.txt')}`, { headers: { Cookie: COOKIE1 } });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(getStoreRows(101).length, 1);
  const forged = await http('/my/recently-viewed/clear', { method: 'POST', headers: { Cookie: COOKIE1, Origin: 'https://evil.example' }, redirect: 'manual' });
  assert.equal(forged.status, 403, 'forged origin should be rejected');
  assert.equal(getStoreRows(101).length, 1, 'forged clear should not delete');
});

test('New Content / ignored state is completely unaffected by Clear', async () => {
  store.clear();
  seenStore.clear();
  await http(`/query/${enc('Guidewire/Gosu/PC/Rating/Partial worksheet print.txt')}`, { headers: { Cookie: COOKIE1 } });
  getSeenSet(101).add(`${TEST_BASE}/doc.pdf`);
  getSeenSet(101).add(`${TEST_BASE}/sheet.xlsx`);
  const seenBefore = new Set(getSeenSet(101));
  await http('/my/recently-viewed/clear', { method: 'POST', headers: { Cookie: COOKIE1 }, redirect: 'manual' });
  assert.deepEqual(getSeenSet(101), seenBefore, 'content_seen untouched');
  assert.equal(getStoreRows(101).length, 0, 'recently_viewed cleared');
});

test('Recently Viewed remains Home-only after Clear feature', async () => {
  store.clear();
  await http(`/query/${enc('Guidewire/Gosu/PC/Rating/Partial worksheet print.txt')}`, { headers: { Cookie: COOKIE1 } });
  await new Promise(r => setTimeout(r, 20));
  const browse = await http(`/browse/${enc(TEST_BASE)}`, { headers: { Cookie: COOKIE1 } });
  const browseHtml = await browse.text();
  assert.doesNotMatch(browseHtml, /Recently Viewed/, 'browse should NOT show Recently Viewed');
  assert.doesNotMatch(browseHtml, /data-testid="clear-recently-viewed"/, 'browse should NOT show Clear');
  const query = await http(`/query/${enc('Guidewire/Gosu/PC/Rating/Partial worksheet print.txt')}`, { headers: { Cookie: COOKIE1 } });
  assert.doesNotMatch(await query.text(), /Recently Viewed/);
  const watch = await http(`/watch/${enc('Videos/Finding Rate table & Routine Usages.mp4')}`, { headers: { Cookie: COOKIE1 } });
  assert.doesNotMatch(await watch.text(), /Recently Viewed/);
  const item = await http(`/item/${enc(TEST_BASE + '/doc.pdf')}`, { headers: { Cookie: COOKIE1 } });
  assert.doesNotMatch(await item.text(), /Recently Viewed/);
});
