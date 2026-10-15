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

const QUERIES_DIR = fileURLToPath(new URL('../queries/', import.meta.url));

const { app } = await import('../src/server.js');
import { markContentIgnored, markContentSeen, getContentStates, MAX_NEW_ITEMS } from '../src/library/new-content.js';

const SID1 = 'ignore-harness-1';
const SID2 = 'ignore-harness-2';
const COOKIE1 = `connect.sid=s:${cookieSignature.sign(SID1, process.env.SESSION_SECRET)}`;
const COOKIE2 = `connect.sid=s:${cookieSignature.sign(SID2, process.env.SESSION_SECRET)}`;

const T0 = Date.now();
const FIRST_LOGIN = new Date(T0);
const NEW_MTIME = new Date(T0 + 60_000);
const NEW_MTIME2 = new Date(T0 + 70_000);
const OLD_MTIME = new Date(T0 - 86400_000);

const USER1 = {
  id: 301,
  google_user_id: 'google-ignore-1',
  email: 'ignore1@example.com',
  name: 'Ignore Tester 1',
  status: 'active',
  first_login_at: FIRST_LOGIN,
  last_login_at: new Date(T0),
  access_expires_at: new Date(Date.now() + 30 * 86400000),
  app_role: 'user'
};
const USER2 = {
  id: 302,
  google_user_id: 'google-ignore-2',
  email: 'ignore2@example.com',
  name: 'Ignore Tester 2',
  status: 'active',
  first_login_at: FIRST_LOGIN,
  last_login_at: new Date(T0),
  access_expires_at: new Date(Date.now() + 30 * 86400000),
  app_role: 'user'
};

const TEST_BASE = '__new_content_ignore_test';
const TEST_NEWFOLDER = '__new_content_ignore_newfolder';
const INTERNAL_DIR = 'Internal';

// content_seen mock: Map<userId, Map<itemPath, 'seen' | 'ignored'>>
const seenMap = new Map();
function stateMap(u) { if (!seenMap.has(u)) seenMap.set(u, new Map()); return seenMap.get(u); }
// recently_viewed mock: Map<userId, Map<itemPath, {id,last_viewed_at,created_at}>>
const recentStore = new Map();
let recentNextId = 1;
let recentClock = Date.now();
function recentNextTime() { recentClock += 1000; return new Date(recentClock); }
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
const ignoreUrl = p => '/my/new-content/ignore/' + enc(p);

async function touch(p, mtime) {
  await utimes(path.join(QUERIES_DIR, ...p.split('/')), mtime, mtime);
}

test.before(async () => {
  await mkdir(path.join(QUERIES_DIR, TEST_BASE, 'sub'), { recursive: true });
  await mkdir(path.join(QUERIES_DIR, TEST_NEWFOLDER), { recursive: true });
  await mkdir(path.join(QUERIES_DIR, INTERNAL_DIR), { recursive: true });
  await writeFile(path.join(QUERIES_DIR, TEST_BASE, 'note.txt'), 'ignore txt content');
  await writeFile(path.join(QUERIES_DIR, TEST_BASE, 'doc.pdf'), randomBytes(128));
  await writeFile(path.join(QUERIES_DIR, TEST_BASE, 'sheet.xlsx'), randomBytes(128));
  await writeFile(path.join(QUERIES_DIR, TEST_BASE, 'image.png'), randomBytes(128));
  await writeFile(path.join(QUERIES_DIR, TEST_BASE, 'bad.exe'), randomBytes(64));
  await writeFile(path.join(QUERIES_DIR, TEST_BASE, 'sub', 'deep.txt'), 'deep content');
  await writeFile(path.join(QUERIES_DIR, TEST_NEWFOLDER, 'fresh.txt'), 'fresh folder content');
  await writeFile(path.join(QUERIES_DIR, TEST_BASE, 'old.txt'), 'historical');
  await writeFile(path.join(QUERIES_DIR, INTERNAL_DIR, '__ignore_hidden.pdf'), randomBytes(128));
  for (let i = 0; i < 25; i++) {
    await writeFile(path.join(QUERIES_DIR, TEST_BASE, `bulk${String(i).padStart(2, '0')}.pdf`), randomBytes(64));
  }
  for (const f of ['note.txt', 'doc.pdf', 'sheet.xlsx', 'image.png', 'bad.exe']) {
    await touch(`${TEST_BASE}/${f}`, NEW_MTIME);
  }
  await touch(`${TEST_BASE}/sub/deep.txt`, NEW_MTIME);
  await touch(`${TEST_NEWFOLDER}/fresh.txt`, NEW_MTIME2);
  await touch(`${TEST_BASE}/old.txt`, OLD_MTIME);
  await touch(`${INTERNAL_DIR}/__ignore_hidden.pdf`, NEW_MTIME);
  for (let i = 0; i < 25; i++) {
    await touch(`${TEST_BASE}/bulk${String(i).padStart(2, '0')}.pdf`, new Date(T0 + 120_000 + i * 1000));
  }

  originalQuery = pool.query;
  pool.query = async (sql, params = []) => {
    if (/SELECT to_regclass/.test(sql)) return { rows: [{ to_regclass: 'user_sessions' }] };
    if (/SELECT sess FROM ["']?user_sessions["']?/i.test(sql)) {
      const sid = params[0];
      if (sid === SID1) return { rows: [{ sess: JSON.stringify({ cookie: {}, passport: { user: 301 } }) }] };
      if (sid === SID2) return { rows: [{ sess: JSON.stringify({ cookie: {}, passport: { user: 302 } }) }] };
      return { rows: [] };
    }
    if (/SELECT \* FROM users WHERE id = \$1/i.test(sql)) {
      const id = params[0];
      if (id === 301) return { rows: [USER1] };
      if (id === 302) return { rows: [USER2] };
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
    // content_seen with seen/ignored distinction
    if (/INSERT INTO content_seen/.test(sql)) {
      for (let i = 0; i < params.length; i += 2) {
        const uId = params[i];
        const p = params[i + 1];
        if (!uId || !p) continue;
        const m = stateMap(uId);
        if (/'ignored'/.test(sql)) {
          if (!m.has(p)) m.set(p, 'ignored'); // DO NOTHING on conflict
        } else {
          m.set(p, 'seen'); // seen insert or ignored->seen upgrade
        }
      }
      return { rows: [] };
    }
    if (/FROM content_seen/.test(sql) && /WHERE user_id/.test(sql)) {
      const m = seenMap.get(params[0]) || new Map();
      if (/item_path,\s*status/i.test(sql)) {
        return { rows: [...m.entries()].map(([item_path, status]) => ({ item_path, status })) };
      }
      return { rows: [...m.keys()].map(item_path => ({ item_path })) };
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
      const m = recentStore.get(params[0]);
      if (m) {
        const sorted = [...m.values()].sort((a, b) => b.last_viewed_at - a.last_viewed_at);
        const keep = new Set(sorted.slice(0, params[1]).map(v => v.id));
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

  // Seed bulk files as ignored so the small fixture set drives most tests;
  // the max-20 test unseeds them explicitly.
  for (const uid of [301, 302]) {
    for (let i = 0; i < 25; i++) {
      stateMap(uid).set(`${TEST_BASE}/bulk${String(i).padStart(2, '0')}.pdf`, 'ignored');
    }
  }
});

test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  if (originalQuery) { pool.query = originalQuery; originalQuery = null; }
  try { await rm(path.join(QUERIES_DIR, TEST_BASE), { recursive: true, force: true }); } catch {}
  try { await rm(path.join(QUERIES_DIR, TEST_NEWFOLDER), { recursive: true, force: true }); } catch {}
  try { await rm(path.join(QUERIES_DIR, INTERNAL_DIR, '__ignore_hidden.pdf'), { force: true }); } catch {}
  seenMap.clear(); recentStore.clear();
});

test('unauthenticated ignore attempts are rejected', async () => {
  const res = await http(ignoreUrl(`${TEST_BASE}/note.txt`), { method: 'POST', redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/login');
  assert.equal(stateMap(301).has(`${TEST_BASE}/note.txt`), false);
});

test('forged origin ignore attempts are rejected', async () => {
  const res = await http(ignoreUrl(`${TEST_BASE}/note.txt`), {
    method: 'POST', headers: { Cookie: COOKIE1, Origin: 'https://evil.example' }, redirect: 'manual'
  });
  assert.equal(res.status, 403);
  assert.equal(stateMap(301).has(`${TEST_BASE}/note.txt`), false);
});

test('ignore removes the item from New Content without affecting others', async () => {
  const p = `${TEST_BASE}/note.txt`;
  let list = await http('/my/new-content', { headers: { Cookie: COOKIE1 } });
  assert.ok((await list.text()).includes(enc(p)), 'precondition: item listed');
  const res = await http(ignoreUrl(p), { method: 'POST', headers: { Cookie: COOKIE1 }, redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/my/new-content');
  list = await http('/my/new-content', { headers: { Cookie: COOKIE1 } });
  const html = await list.text();
  assert.ok(!html.includes(enc(p)), 'ignored item must disappear');
  // Other new items are unaffected
  for (const other of [`${TEST_BASE}/doc.pdf`, `${TEST_BASE}/sheet.xlsx`, `${TEST_BASE}/sub/deep.txt`, `${TEST_NEWFOLDER}/fresh.txt`]) {
    assert.ok(html.includes(enc(other)), `${other} must remain`);
  }
});

test('ignored item is not added to Recently Viewed and remains not-viewed', async () => {
  const p = `${TEST_BASE}/note.txt`;
  assert.ok(!recentRows(301).some(r => r.item_path === p), 'ignore must not record recently viewed');
  const states = await getContentStates(301);
  assert.equal(states.get(p), 'ignored', 'ignored state stored distinctly from seen');
  // List page offers a clear Ignore action per item (not a viewed affordance)
  const list = await http('/my/new-content', { headers: { Cookie: COOKIE1 } });
  assert.match(await list.text(), /data-testid="ignore-item"/);
});

test('different users have independent ignore state', async () => {
  const p = `${TEST_BASE}/note.txt`;
  // USER1 ignored note.txt; USER2 still sees it
  let list2 = await http('/my/new-content', { headers: { Cookie: COOKIE2 } });
  assert.ok((await list2.text()).includes(enc(p)), 'other user still sees item');
  assert.equal((await getContentStates(302)).has(p), false);
  // USER2 ignores a different item; USER1 is unaffected
  const q = `${TEST_BASE}/doc.pdf`;
  const res = await http(ignoreUrl(q), { method: 'POST', headers: { Cookie: COOKIE2 }, redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal((await getContentStates(302)).get(q), 'ignored');
  const list1 = await http('/my/new-content', { headers: { Cookie: COOKIE1 } });
  assert.ok((await list1.text()).includes(enc(q)), 'first user still sees item ignored by second user');
  list2 = await http('/my/new-content', { headers: { Cookie: COOKIE2 } });
  assert.ok(!(await list2.text()).includes(enc(q)));
});

test('ignoring all items makes the banner disappear', async () => {
  // USER2: bulk already ignored; ignore every remaining listed item via real flow
  const list = await http('/my/new-content', { headers: { Cookie: COOKIE2 } });
  const html = await list.text();
  const paths = [...html.matchAll(/data-path="([^"]+)"/g)].map(m => m[1]);
  assert.ok(paths.length > 0, 'precondition: items listed');
  for (const p of paths) {
    const res = await http(ignoreUrl(p), { method: 'POST', headers: { Cookie: COOKIE2 }, redirect: 'manual' });
    assert.equal(res.status, 302);
  }
  const home = await http('/', { headers: { Cookie: COOKIE2 } });
  assert.doesNotMatch(await home.text(), /data-testid="new-content-banner"/);
  const empty = await http('/my/new-content', { headers: { Cookie: COOKIE2 } });
  assert.match(await empty.text(), /data-testid="new-content-empty"/);
});

test('opening an item still marks it seen (not ignored)', async () => {
  const p = `${TEST_BASE}/sheet.xlsx`;
  const open = await http('/item/' + enc(p), { headers: { Cookie: COOKIE1 } });
  assert.equal(open.status, 200);
  assert.equal((await getContentStates(301)).get(p), 'seen');
  assert.ok(recentRows(301).some(r => r.item_path === p), 'opened item recorded in recently viewed');
  const list = await http('/my/new-content', { headers: { Cookie: COOKIE1 } });
  assert.ok(!(await list.text()).includes(enc(p)));
});

test('seen items stay seen: ignore-after-open keeps seen, open-after-ignore upgrades to seen', async () => {
  // Open then ignore -> must remain 'seen' (ignore never overwrites a view)
  const a = `${TEST_NEWFOLDER}/fresh.txt`;
  assert.equal((await http('/item/' + enc(a), { headers: { Cookie: COOKIE1 } })).status, 200);
  assert.equal((await getContentStates(301)).get(a), 'seen');
  assert.equal((await http(ignoreUrl(a), { method: 'POST', headers: { Cookie: COOKIE1 }, redirect: 'manual' })).status, 302);
  assert.equal((await getContentStates(301)).get(a), 'seen', 'ignore must not overwrite seen');
  // Ignore then open -> becomes 'seen' (it was actually viewed)
  const b = `${TEST_BASE}/image.png`;
  assert.equal((await http(ignoreUrl(b), { method: 'POST', headers: { Cookie: COOKIE1 }, redirect: 'manual' })).status, 302);
  assert.equal((await getContentStates(301)).get(b), 'ignored');
  assert.equal((await http('/item/' + enc(b), { headers: { Cookie: COOKIE1 } })).status, 200);
  assert.equal((await getContentStates(301)).get(b), 'seen', 'later open upgrades ignored to seen');
  assert.ok(recentRows(301).some(r => r.item_path === b));
});

test('invalid and inaccessible content cannot be ignored', async () => {
  // Unsafe path (backslash) -> 400
  const bad = await http('/my/new-content/ignore/bad%5Cpath.txt', { method: 'POST', headers: { Cookie: COOKIE1 }, redirect: 'manual' });
  assert.equal(bad.status, 400);
  // Missing file -> 404
  const missing = await http(ignoreUrl(`${TEST_BASE}/does-not-exist.pdf`), { method: 'POST', headers: { Cookie: COOKIE1 }, redirect: 'manual' });
  assert.equal(missing.status, 404);
  // Restricted (HIDDEN_FOLDERS) content -> 404 without leaking
  const hidden = await http(ignoreUrl(`${INTERNAL_DIR}/__ignore_hidden.pdf`), { method: 'POST', headers: { Cookie: COOKIE1 }, redirect: 'manual' });
  assert.equal(hidden.status, 404);
  assert.ok(!(await hidden.text()).includes('__ignore_hidden'));
  // Unsupported type (.exe is not a supported content type) -> 404
  const exe = await http(ignoreUrl(`${TEST_BASE}/bad.exe`), { method: 'POST', headers: { Cookie: COOKIE1 }, redirect: 'manual' });
  assert.equal(exe.status, 404);
  // None of the above created acknowledgement state
  const states = await getContentStates(301);
  assert.equal(states.has('bad\\path.txt'), false);
  assert.equal(states.has(`${TEST_BASE}/does-not-exist.pdf`), false);
  assert.equal(states.has(`${INTERNAL_DIR}/__ignore_hidden.pdf`), false);
  assert.equal(states.has(`${TEST_BASE}/bad.exe`), false);
});

test('maximum 20 behavior remains correct with ignore', async () => {
  assert.equal(MAX_NEW_ITEMS, 20);
  // Unseed bulk for USER1: 25 eligible bulk files (newest) plus older small fixtures
  for (let i = 0; i < 25; i++) stateMap(301).delete(`${TEST_BASE}/bulk${String(i).padStart(2, '0')}.pdf`);
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
  assert.ok(idx24 !== -1 && idx20 !== -1 && idx24 < idx20, 'newest first');
  // Ignoring one of the 20 promotes the next newest while keeping the cap
  assert.equal((await http(ignoreUrl(`${TEST_BASE}/bulk24.pdf`), { method: 'POST', headers: { Cookie: COOKIE1 }, redirect: 'manual' })).status, 302);
  const html2 = await (await http('/my/new-content', { headers: { Cookie: COOKIE1 } })).text();
  const matches2 = html2.match(/data-testid="new-content-item"/g) || [];
  assert.equal(matches2.length, 20);
  assert.ok(!html2.includes(enc(`${TEST_BASE}/bulk24.pdf`)));
  assert.ok(html2.includes(enc(`${TEST_BASE}/bulk04.pdf`)), 'next newest promoted after ignore');
  assert.equal((await getContentStates(301)).get(`${TEST_BASE}/bulk24.pdf`), 'ignored');
});

test('direct module API for ignored state', async () => {
  await markContentIgnored(null, 'x');
  await markContentIgnored(301, '   ');
  await markContentIgnored(301, `${TEST_BASE}/direct-ignore-probe.txt`);
  const states = await getContentStates(301);
  assert.equal(states.get(`${TEST_BASE}/direct-ignore-probe.txt`), 'ignored');
  // Ignoring an already-seen item keeps it seen
  await markContentSeen(301, `${TEST_BASE}/direct-seen-probe.txt`);
  await markContentIgnored(301, `${TEST_BASE}/direct-seen-probe.txt`);
  assert.equal((await getContentStates(301)).get(`${TEST_BASE}/direct-seen-probe.txt`), 'seen');
  assert.deepEqual(await getContentStates(99999), new Map());
});

test('Ignore All clears ALL current new/missed content in a single action regardless of count exceeding batch limit', async () => {
  // Clear any existing seen map for USER1
  if (seenMap.has(301)) seenMap.get(301).clear();

  // Verify there are >20 items eligible (we created 25 bulk items + 5 base files)
  const listBefore = await http('/my/new-content', { headers: { Cookie: COOKIE1 } });
  const htmlBefore = await listBefore.text();
  const matchesBefore = htmlBefore.match(/data-testid="new-content-item"/g) || [];
  assert.equal(matchesBefore.length, 20, 'UI list caps display at 20');

  // Trigger Ignore All action
  const res = await http('/my/new-content/ignore-all', { method: 'POST', headers: { Cookie: COOKIE1 }, redirect: 'manual' });
  assert.equal(res.status, 302, 'Redirects after Ignore All');

  // Check state map for user 301
  const userStates = await getContentStates(301);
  // All 25 bulk items plus other eligible files should be marked 'ignored' in userStates
  let ignoredCount = 0;
  for (const [key, val] of userStates.entries()) {
    if (val === 'ignored') ignoredCount++;
  }
  assert.ok(ignoredCount > 20, `Ignore All cleared all ${ignoredCount} items (exceeding batch limit of 20) in a single action`);

  // Verify Home page banner disappears and /my/new-content reports empty
  const home = await http('/', { headers: { Cookie: COOKIE1 } });
  assert.doesNotMatch(await home.text(), /data-testid="new-content-banner"/);
  const listAfter = await http('/my/new-content', { headers: { Cookie: COOKIE1 } });
  assert.match(await listAfter.text(), /data-testid="new-content-empty"/);
});
