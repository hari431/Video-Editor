import './helpers/env.js';
process.env.ADMIN_EMAILS = 'admin@example.com';

import test from 'node:test';
import assert from 'node:assert/strict';
import cookieSignature from 'cookie-signature';
import { pool } from '../src/db/pool.js';

const { app } = await import('../src/server.js');

const EXPIRED_USER = {
  id: 55,
  google_user_id: 'google-expired',
  email: 'expired@example.com',
  name: 'Expired User',
  status: 'expired',
  app_role: 'USER',
  first_login_at: new Date(),
  last_login_at: new Date(),
  access_expires_at: new Date(Date.now() - 86400000).toISOString(),
};

const ACTIVE_USER = {
  id: 56,
  google_user_id: 'google-active',
  email: 'active@example.com',
  name: 'Active User',
  status: 'active',
  app_role: 'USER',
  first_login_at: new Date(),
  last_login_at: new Date(),
  access_expires_at: new Date(Date.now() + 86400000).toISOString(),
};

const ADMIN_USER = {
  id: 99,
  google_user_id: 'google-admin',
  email: 'admin@example.com',
  name: 'Admin',
  status: 'active',
  app_role: 'ADMIN',
  access_expires_at: null,
  first_login_at: new Date(),
  last_login_at: new Date(),
};

const SID_EX = 'expired-ro-sid';
const COOKIE_EX = `connect.sid=s:${cookieSignature.sign(SID_EX, process.env.SESSION_SECRET)}`;
const SID_AC = 'active-ro-sid';
const COOKIE_AC = `connect.sid=s:${cookieSignature.sign(SID_AC, process.env.SESSION_SECRET)}`;
const SID_AD = 'admin-ro-sid';
const COOKIE_AD = `connect.sid=s:${cookieSignature.sign(SID_AD, process.env.SESSION_SECRET)}`;

const sessionToUser = {
  [SID_EX]: EXPIRED_USER,
  [SID_AC]: ACTIVE_USER,
  [SID_AD]: ADMIN_USER,
};

let originalQuery, server, port;
let discussionsInDB = [];
let repliesInDB = [];

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
      const uid = Number(params[0]);
      const u = [EXPIRED_USER, ACTIVE_USER, ADMIN_USER].find(x => x.id === uid);
      return { rows: u ? [u] : [], rowCount: u ? 1 : 0 };
    }
    // hasNotesPermission checks – grant for active and admin, deny for expired
    if (/SELECT 1 FROM content_action_permissions/.test(sql)) {
      const uid = Number(params[0]);
      if (uid === 56 || uid === 99) return { rows: [{ '?column?': 1 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }
    if (/user_roles/.test(sql) && /notes_available/.test(sql)) {
      const uid = Number(params[0]);
      if (uid === 56 || uid === 99) return { rows: [{ '?column?': 1 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }
    if (/SELECT 1 FROM roles WHERE id = ANY/.test(sql)) return { rows: [], rowCount: 0 };
    if (/user_roles/.test(sql)) return { rows: [] };
    if (/folder_permissions/.test(sql)) return { rows: [{ folder_path: 'Guidewire', access_level: 'all', role_id: null }] };
    if (/SELECT path, ad_state FROM ad_settings/.test(sql)) return { rows: [] };
    if (/INSERT INTO discussions/.test(sql)) {
      const d = { id: discussionsInDB.length + 100, user_id: params[0], item_path: params[1], title: params[2], body: params[3] || '', status: 'visible', created_at: new Date(), updated_at: new Date(), author_name: 'Active User', author_email: 'active@example.com' };
      discussionsInDB.push(d);
      return { rows: [d] };
    }
    if (/INSERT INTO discussion_replies/.test(sql)) {
      const r = { id: repliesInDB.length + 200, discussion_id: params[0], user_id: params[1], body: params[2], status: 'visible', created_at: new Date(), updated_at: new Date(), author_name: 'Active User', author_email: 'active@example.com', author_app_role: 'USER' };
      repliesInDB.push(r);
      return { rows: [r] };
    }
    if (/SELECT d\.\*, u\.email AS author_email/.test(sql)) {
      const d = discussionsInDB.find(x => x.id === params[0]);
      if (d) return { rows: [{ ...d, author_email: d.author_email || 'active@example.com', author_name: d.author_name || 'Active User', like_count: 0, user_liked: false }] };
      // fallback single discussion for view test
      return { rows: [{ id: 1, user_id: 56, item_path: 'Guidewire/test.txt', title: 'Test Q', body: 'Test body https://youtube.com/watch?v=123', status: 'visible', created_at: new Date(), updated_at: new Date(), author_email: 'active@example.com', author_name: 'Active User', like_count: 0, user_liked: false }] };
    }
    if (/FROM discussions d/.test(sql) && /GROUP BY/.test(sql)) {
      // listDiscussions
      return { rows: discussionsInDB.map(d => ({ ...d, reply_count: 0, accepted_count: 0 })) };
    }
    if (/SELECT r\.\*, u\.email AS author_email/.test(sql)) {
      return { rows: repliesInDB };
    }
    if (/SELECT r\.id, r\.user_id, r\.discussion_id/.test(sql)) {
      return { rows: [] };
    }
    if (/discussion_likes/.test(sql) || /reply_likes/.test(sql)) return { rows: [] };
    if (/SELECT COUNT/.test(sql) && /item_likes/.test(sql)) return { rows: [{ cnt: '0' }] };
    if (/SELECT id FROM item_likes/.test(sql)) return { rows: [] };
    if (/video_views/.test(sql)) return { rows: [{ cnt: '0' }] };
    if (/INSERT INTO video_views/.test(sql)) return { rows: [] };
    return { rows: [] };
  };
  server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  port = server.address().port;
  // seed one visible discussion for read tests
  discussionsInDB = [{ id: 1, user_id: 56, item_path: 'Guidewire/test.txt', title: 'Existing question', body: 'Body with https://youtube.com/watch?v=123', status: 'visible', created_at: new Date(), updated_at: new Date(), author_name: 'Active User', author_email: 'active@example.com' }];
  repliesInDB = [{ id: 10, discussion_id: 1, user_id: 56, body: 'Existing reply', status: 'visible', created_at: new Date(), updated_at: new Date(), author_name: 'Active User', author_email: 'active@example.com', author_app_role: 'USER', like_count: 0, user_liked: false }];
});

test.after(async () => {
  if (server) await new Promise(r => server.close(r));
  pool.query = originalQuery;
});

const http = (p, opts) => fetch(`http://127.0.0.1:${port}${p}`, opts);

test('expired can view discussions list (GET /discussions)', async () => {
  const res = await http('/discussions?path=Guidewire%2Ftest.txt', { headers: { Cookie: COOKIE_EX } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Existing question/);
});

test('expired can open individual discussion (GET /discussions/:id)', async () => {
  const res = await http('/discussions/1', { headers: { Cookie: COOKIE_EX } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Existing question/);
  assert.match(html, /Existing reply/);
});

test('expired sees read-only message and no question form on list', async () => {
  const res = await http('/discussions?path=Guidewire%2Ftest.txt', { headers: { Cookie: COOKIE_EX } });
  const html = await res.text();
  assert.match(html, /read-only mode/i);
  assert.match(html, /Discussions are available in read-only mode/);
  assert.doesNotMatch(html, /class="discussion-new-form"/);
});

test('active sees question form', async () => {
  const res = await http('/discussions?path=Guidewire%2Ftest.txt', { headers: { Cookie: COOKIE_AC } });
  const html = await res.text();
  assert.match(html, /class="discussion-new-form"/);
  assert.doesNotMatch(html, /data-testid="discussions-readonly-msg"/);
});

test('expired thread hides Post Reply and like controls, shows read-only', async () => {
  const res = await http('/discussions/1', { headers: { Cookie: COOKIE_EX } });
  const html = await res.text();
  // like forms should be hidden
  assert.doesNotMatch(html, /action="\/discussions\/1\/like"/);
  assert.doesNotMatch(html, /action="\/discussions\/replies\/10\/like"/);
  // reply forms hidden
  assert.doesNotMatch(html, /class="discussion-reply-form"/);
  assert.doesNotMatch(html, /class="reply-inline-form/);
  assert.doesNotMatch(html, /toggle-reply-btn/);
  assert.match(html, /read-only mode/i);
});

test('active thread shows Post Reply and like controls', async () => {
  const res = await http('/discussions/1', { headers: { Cookie: COOKIE_AC } });
  const html = await res.text();
  assert.match(html, /action="\/discussions\/1\/like"/);
  assert.match(html, /class="discussion-reply-form"/);
});

test('expired cannot create discussion (POST)', async () => {
  const res = await http('/discussions', {
    method: 'POST',
    headers: { Cookie: COOKIE_EX, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ item_path: 'Guidewire/test.txt', title: 'New Q', body: 'b' }),
    redirect: 'manual'
  });
  // should be 403 (our guard renders error)
  assert.equal(res.status, 403);
  const text = await res.text();
  assert.match(text, /permission/i);
});

test('expired cannot post reply', async () => {
  const res = await http('/discussions/1/reply', {
    method: 'POST',
    headers: { Cookie: COOKIE_EX, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ body: 'my reply' }),
    redirect: 'manual'
  });
  assert.equal(res.status, 403);
});

test('expired cannot like discussion', async () => {
  const res = await http('/discussions/1/like', { method: 'POST', headers: { Cookie: COOKIE_EX }, redirect: 'manual' });
  assert.equal(res.status, 403);
});

test('expired cannot like reply', async () => {
  const res = await http('/discussions/replies/10/like', { method: 'POST', headers: { Cookie: COOKIE_EX }, redirect: 'manual' });
  assert.equal(res.status, 403);
});

test('admin (expired admin not possible) can still post – bypass', async () => {
  const res = await http('/discussions', {
    method: 'POST',
    headers: { Cookie: COOKIE_AD, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ item_path: 'Guidewire/test.txt', title: 'Admin Q', body: 'b' }),
    redirect: 'manual'
  });
  // admin should be allowed (302 redirect)
  assert.equal(res.status, 302);
});

test('expired cannot delete discussion (write guard)', async () => {
  const res = await http('/discussions/1/delete', { method: 'POST', headers: { Cookie: COOKIE_EX }, redirect: 'manual' });
  assert.equal(res.status, 403);
});
