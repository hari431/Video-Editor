import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';
import cookieSignature from 'cookie-signature';
import { pool } from '../src/db/pool.js';
import { contentRouteForPath } from '../src/library/local.js';
import { countLibraryTree, formatIST, formatISTDate, getAnalyticsOverview } from '../src/library/analytics.js';

const { app } = await import('../src/server.js');

const OWNER = {
  id: 1, google_user_id: 'google-owner', email: 'owner@example.com', name: 'Owner',
  status: 'active', first_login_at: new Date(), last_login_at: new Date(),
  access_expires_at: null, app_role: 'OWNER'
};
const ADMIN = {
  id: 2, google_user_id: 'google-admin', email: 'admin@example.com', name: 'Admin',
  status: 'active', first_login_at: new Date(), last_login_at: new Date(),
  access_expires_at: null, app_role: 'ADMIN'
};
const USER = {
  id: 3, google_user_id: 'google-user', email: 'user@example.com', name: 'Normal User',
  status: 'active', first_login_at: new Date(), last_login_at: new Date(),
  access_expires_at: new Date(Date.now() + 30 * 86400000), app_role: 'USER'
};

const OWNER_SID = 'analytics-owner-sid';
const ADMIN_SID = 'analytics-admin-sid';
const USER_SID = 'analytics-user-sid';
const OWNER_COOKIE = `connect.sid=s:${cookieSignature.sign(OWNER_SID, process.env.SESSION_SECRET)}`;
const ADMIN_COOKIE = `connect.sid=s:${cookieSignature.sign(ADMIN_SID, process.env.SESSION_SECRET)}`;
const USER_COOKIE = `connect.sid=s:${cookieSignature.sign(USER_SID, process.env.SESSION_SECRET)}`;
const sessionToUser = { [OWNER_SID]: OWNER, [ADMIN_SID]: ADMIN, [USER_SID]: USER };

// Controlled analytics fixtures
const FIX = {
  users: { total_users: 10, active_users: 6, expired_users: 2, never_expires_users: 2, new_30d_users: 3 },
  discussions: { total_questions: 7, answered_questions: 4, unanswered_questions: 3, total_replies: 9, accepted_answers: 5, new_30d_questions: 2 },
  topLiked: [
    { item_path: 'Guidewire/Gosu/PC/Rating/a.txt', like_count: 5, last_liked_at: new Date('2024-02-01T10:00:00Z') },
    { item_path: 'Tutorials/vid.mp4', like_count: 3, last_liked_at: new Date('2024-02-02T10:00:00Z') }
  ],
  topViewed: [
    { item_path: 'Guidewire/Gosu/PC/Rating/a.txt', viewer_count: 8, last_viewed_at: new Date('2024-03-01T10:00:00Z') }
  ],
  recentLogins: [{ id: 1, name: 'Owner', email: 'owner@example.com', last_login_at: new Date('2024-03-05T10:00:00Z') }],
  recentQuestions: [{ id: 42, title: 'How does rating work?', item_path: 'Guidewire/Gosu/PC/Rating/a.txt', created_at: new Date('2024-03-06T10:00:00Z'), author_name: 'Normal User' }],
  recentViews: [{ item_path: 'Guidewire/Gosu/PC/Rating/a.txt', last_viewed_at: new Date('2024-03-07T10:00:00Z'), viewer_name: 'Normal User' }]
};

let emptyMode = false;
let originalQuery = null;
let server = null;
let port = 0;

test.before(async () => {
  originalQuery = pool.query;
  pool.query = async (sql, params = []) => {
    if (/SELECT to_regclass/.test(sql)) return { rows: [{ to_regclass: 'user_sessions' }] };
    if (/SELECT sess FROM ["']?user_sessions["']?/i.test(sql)) {
      const u = sessionToUser[params[0]];
      if (u) return { rows: [{ sess: JSON.stringify({ cookie: {}, passport: { user: u.id } }) }] };
      return { rows: [] };
    }
    if (/SELECT \* FROM users WHERE id = \$1/i.test(sql)) {
      const u = [OWNER, ADMIN, USER].find(x => x.id === params[0]);
      return { rows: u ? [u] : [] };
    }
    if (/user_roles/.test(sql)) return { rows: [] };
    if (/FROM folder_permissions fp/.test(sql) || (/folder_permissions/.test(sql) && /access_level/.test(sql))) {
      return { rows: [{ folder_path: 'Guidewire', access_level: 'all', role_id: null }, { folder_path: 'Tutorials', access_level: 'all', role_id: null }] };
    }
    if (emptyMode) {
      if (/FROM users/.test(sql) && /COUNT/.test(sql)) return { rows: [{ total_users: 0, active_users: 0, expired_users: 0, never_expires_users: 0, new_30d_users: 0 }] };
      if (/FROM discussions d/.test(sql) && /EXISTS/.test(sql)) return { rows: [{ total_questions: 0, answered_questions: 0, unanswered_questions: 0, total_replies: 0, accepted_answers: 0, new_30d_questions: 0 }] };
      if (/GROUP BY item_path/.test(sql)) return { rows: [] };
      if (/ORDER BY last_login_at DESC/.test(sql)) return { rows: [] };
      if (/ORDER BY d\.created_at DESC/.test(sql)) return { rows: [] };
      if (/ORDER BY r\.last_viewed_at DESC/.test(sql)) return { rows: [] };
      return { rows: [] };
    }
    // User overview aggregate
    if (/FROM users/.test(sql) && /total_users|active_users/.test(sql)) return { rows: [FIX.users] };
    // Discussion overview aggregate (has EXISTS subqueries)
    if (/FROM discussions d/.test(sql) && /answered_questions/.test(sql)) return { rows: [FIX.discussions] };
    // Top liked: item_likes + GROUP BY
    if (/FROM item_likes/.test(sql) && /GROUP BY/.test(sql)) return { rows: FIX.topLiked };
    // Top viewed: recently_viewed + GROUP BY
    if (/FROM recently_viewed/.test(sql) && /GROUP BY/.test(sql)) return { rows: FIX.topViewed };
    // Recent logins
    if (/FROM users/.test(sql) && /ORDER BY last_login_at DESC/.test(sql)) return { rows: FIX.recentLogins };
    // Recent questions
    if (/FROM discussions d/.test(sql) && /JOIN users/.test(sql) && /ORDER BY d\.created_at DESC/.test(sql)) return { rows: FIX.recentQuestions };
    // Recent views
    if (/FROM recently_viewed r/.test(sql) && /JOIN users/.test(sql)) return { rows: FIX.recentViews };
    return { rows: [] };
  };
  server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  port = server.address().port;
});

test.after(async () => {
  if (server) await new Promise(r => server.close(r));
  if (originalQuery) { pool.query = originalQuery; originalQuery = null; }
});

const http = (suffix, init) => fetch(`http://127.0.0.1:${port}${suffix}`, init);

test('Owner can access Analytics', async () => {
  const res = await http('/admin/analytics', { headers: { Cookie: OWNER_COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Analytics/);
});

test('Admin can access Analytics', async () => {
  const res = await http('/admin/analytics', { headers: { Cookie: ADMIN_COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /User Overview/);
});

test('Normal User receives 403 Forbidden', async () => {
  const res = await http('/admin/analytics', { headers: { Cookie: USER_COOKIE } });
  assert.equal(res.status, 403);
  const body = await res.text();
  assert.equal(body, 'Forbidden');
});

test('Unauthenticated user follows existing authentication behavior (redirect to /login)', async () => {
  const res = await http('/admin/analytics', { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/login');
});

test('User counts are correct', async () => {
  const res = await http('/admin/analytics', { headers: { Cookie: OWNER_COOKIE } });
  const html = await res.text();
  assert.ok(html.includes(`<strong>${FIX.users.total_users}</strong>`), 'total users shown');
  assert.ok(html.includes(`<strong>${FIX.users.active_users}</strong>`), 'active users shown');
  assert.ok(html.includes(`<strong>${FIX.users.expired_users}</strong>`), 'expired users shown');
  assert.ok(html.includes(`<strong>${FIX.users.new_30d_users}</strong>`), 'new users shown');
});

test('Active/expired/Never-expire calculations treat permanent accounts correctly', async () => {
  const src = fs.readFileSync(new URL('../src/library/analytics.js', import.meta.url), 'utf8');
  assert.match(src, /app_role IN \('OWNER','ADMIN'\)/, 'must reference Owner/Admin roles');
  assert.match(src, /access_expires_at > NOW\(\)/, 'active uses expiry rule');
  assert.match(src, /access_expires_at IS NULL/, 'NULL expiry handled');
  assert.match(src, /NOT IN \('OWNER','ADMIN'\)/, 'expired excludes permanent accounts');
  const res = await http('/admin/analytics', { headers: { Cookie: OWNER_COOKIE } });
  const html = await res.text();
  assert.match(html, /Never expires/, 'Never expires shown');
  assert.ok(html.includes(String(FIX.users.never_expires_users)));
});

test('Discussion counts are correct', async () => {
  const res = await http('/admin/analytics', { headers: { Cookie: OWNER_COOKIE } });
  const html = await res.text();
  for (const v of [FIX.discussions.total_questions, FIX.discussions.answered_questions, FIX.discussions.unanswered_questions, FIX.discussions.total_replies, FIX.discussions.new_30d_questions]) {
    assert.ok(html.includes(`<strong>${v}</strong>`), `discussion value ${v} shown`);
  }
});

test('Accepted-answer counts use multiple-accepted-answer implementation', async () => {
  const src = fs.readFileSync(new URL('../src/library/analytics.js', import.meta.url), 'utf8');
  assert.match(src, /accepted_at IS NOT NULL/, 'must count accepted_at rows');
  assert.ok(!/accepted_reply_id/.test(src), 'must not use legacy single-answer column');
  const res = await http('/admin/analytics', { headers: { Cookie: OWNER_COOKIE } });
  const html = await res.text();
  assert.ok(html.includes(`<strong>${FIX.discussions.accepted_answers}</strong>`));
});

test('Likes/Recently Viewed statistics are correct', async () => {
  const res = await http('/admin/analytics', { headers: { Cookie: OWNER_COOKIE } });
  const html = await res.text();
  assert.match(html, /Most liked content/);
  assert.match(html, /Most viewed content/);
  assert.ok(html.includes('a.txt'), 'liked item shown');
  assert.ok(html.includes('<td>5</td>'), 'like count shown');
  assert.ok(html.includes('<td>8</td>'), 'viewer count shown');
});

test('Content links use the existing routing system', async () => {
  const src = fs.readFileSync(new URL('../src/library/analytics.js', import.meta.url), 'utf8');
  const viewSrc = fs.readFileSync(fileURLToPath(new URL('../src/views/admin-analytics.ejs', import.meta.url)), 'utf8');
  // Route helper imported in server and passed to view; view must use it (no hardcoded new scheme)
  assert.ok(viewSrc.includes('contentRouteForPath'), 'view must use contentRouteForPath');
  assert.ok(!/\/analytics\/content\//.test(viewSrc), 'must not invent a new URL scheme');
  assert.equal(contentRouteForPath('Guidewire/x/a.txt'), '/query/');
  assert.equal(contentRouteForPath('Tutorials/vid.mp4'), '/watch/');
  assert.equal(contentRouteForPath('Guidewire/x/doc.pdf'), '/item/');
  const res = await http('/admin/analytics', { headers: { Cookie: OWNER_COOKIE } });
  const html = await res.text();
  assert.ok(html.includes('/query/Guidewire/Gosu/PC/Rating/a.txt'), 'txt uses /query/');
  assert.ok(html.includes('/watch/Tutorials/vid.mp4'), 'video uses /watch/');
  const serverSrc = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.ok(serverSrc.includes('contentRouteForPath'), 'server passes existing helper to analytics view');
});

test('IST date/time formatting', async () => {
  const viewSrc = fs.readFileSync(fileURLToPath(new URL('../src/views/admin-analytics.ejs', import.meta.url)), 'utf8');
  assert.ok(viewSrc.includes('Asia/Kolkata'), 'analytics view must use Asia/Kolkata');
  const utc = '2024-01-15T10:00:00.000Z';
  const expected = new Date(utc).toLocaleString(undefined, { timeZone: 'Asia/Kolkata' });
  assert.equal(formatIST(utc), expected);
  const expectedDate = new Date(utc).toLocaleDateString(undefined, { timeZone: 'Asia/Kolkata' });
  assert.equal(formatISTDate(utc), expectedDate);
  assert.equal(formatIST(null), '—');
  const res = await http('/admin/analytics', { headers: { Cookie: OWNER_COOKIE } });
  const html = await res.text();
  const expectedLogin = new Date(FIX.recentLogins[0].last_login_at).toLocaleString(undefined, { timeZone: 'Asia/Kolkata' });
  assert.ok(html.includes(expectedLogin), 'recent login rendered in IST');
});

test('Empty datasets render safely', async () => {
  emptyMode = true;
  try {
    const res = await http('/admin/analytics', { headers: { Cookie: OWNER_COOKIE } });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /No viewed content yet/);
    assert.match(html, /No liked content yet/);
    assert.match(html, /No recent logins/);
    assert.match(html, /No recently viewed content/);
    assert.match(html, /No recent questions/);
  } finally {
    emptyMode = false;
  }
});

test('Analytics route is Admin-only with no public API', async () => {
  const serverSrc = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  const line = serverSrc.split('\n').find(l => l.includes("'/admin/analytics'"));
  assert.ok(line.includes('requireAuth'), 'must require auth');
  assert.ok(line.includes('requireAdmin'), 'must require admin');
  assert.ok(!serverSrc.includes('/api/analytics'), 'must not create public analytics API');
});

test('Analytics does not expose sensitive columns', async () => {
  const src = fs.readFileSync(new URL('../src/library/analytics.js', import.meta.url), 'utf8');
  assert.ok(!/SELECT[^;]*google_user_id/s.test(src), 'must not select OAuth id');
  assert.ok(!/SELECT[^;]*password/si.test(src), 'must not select passwords');
  assert.ok(!/SELECT[^;]*token/si.test(src), 'must not select tokens');
  const res = await http('/admin/analytics', { headers: { Cookie: OWNER_COOKIE } });
  const html = await res.text();
  assert.ok(!/google-user/.test(html), 'no OAuth ids in HTML');
});

test('Admin navigation includes Analytics entry', async () => {
  const adminSrc = fs.readFileSync(fileURLToPath(new URL('../src/views/admin.ejs', import.meta.url)), 'utf8');
  assert.ok(adminSrc.includes('/admin/analytics') || adminSrc.includes('partials/admin-nav'), 'admin dashboard links to analytics');
});

test('Library counts derived without loading entire library per-stat (uses cached tree)', async () => {
  // countLibraryTree walks an in-memory tree once; verify with a synthetic tree
  const tree = {
    name: '', path: '', type: 'folder',
    children: new Map([
      ['A', { name: 'A', path: 'A', type: 'folder', children: new Map([['f.txt', { name: 'f.txt', path: 'A/f.txt', type: 'file' }]]) }],
      ['v.mp4', { name: 'v.mp4', path: 'v.mp4', type: 'video' }]
    ])
  };
  assert.deepEqual(countLibraryTree(tree), { totalFolders: 1, totalItems: 2 });
  const agg = await getAnalyticsOverview(tree);
  assert.equal(agg.library.totalItems, 2);
  assert.equal(agg.library.totalFolders, 1);
});
