import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import cookieSignature from 'cookie-signature';
import { pool } from '../src/db/pool.js';

const { app } = await import('../src/server.js');

const OWNER = { id: 10, email: 'owner@example.com', name: 'Owner', status: 'active', app_role: 'OWNER' };
const ADMIN = { id: 11, email: 'admin@example.com', name: 'Admin', status: 'active', app_role: 'ADMIN' };
const USER = { id: 99, email: 'user@example.com', name: 'User', status: 'active', app_role: 'MEMBER', access_expires_at: new Date(Date.now() + 86400000).toISOString() };

const OWNER_SID = 'delete-owner-sid';
const ADMIN_SID = 'delete-admin-sid';
const USER_SID = 'delete-user-sid';

const OWNER_COOKIE = `connect.sid=s:${cookieSignature.sign(OWNER_SID, process.env.SESSION_SECRET)}`;
const ADMIN_COOKIE = `connect.sid=s:${cookieSignature.sign(ADMIN_SID, process.env.SESSION_SECRET)}`;
const USER_COOKIE = `connect.sid=s:${cookieSignature.sign(USER_SID, process.env.SESSION_SECRET)}`;

const sessionToUser = {
  [OWNER_SID]: OWNER,
  [ADMIN_SID]: ADMIN,
  [USER_SID]: USER
};

let originalQuery = null;
let originalConnect = null;
let server = null;
let port = 0;
let calls = [];

test.before(async () => {
  server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  port = server.address().port;
});

test.after(async () => {
  if (server) await new Promise(r => server.close(r));
});

function installPoolStub(handler) {
  originalQuery = pool.query;
  originalConnect = pool.connect;
  calls = [];
  
  const mockQuery = async (sql, params = []) => {
    calls.push({ sql, params });
    if (/SELECT to_regclass/.test(sql)) return { rows: [{ to_regclass: 'user_sessions' }] };
    if (/SELECT sess FROM ["']?user_sessions["']?/i.test(sql)) {
      const u = sessionToUser[params[0]];
      if (u) return { rows: [{ sess: JSON.stringify({ cookie: {}, passport: { user: u.id } }) }] };
      return { rows: [] };
    }
    if (/SELECT .* FROM users WHERE id = \$1/i.test(sql)) {
      const uid = Number(params[0]);
      if (uid === 10) return { rowCount: 1, rows: [OWNER] };
      if (uid === 11) return { rowCount: 1, rows: [ADMIN] };
      if (uid === 99) return { rowCount: 1, rows: [USER] };
      return { rowCount: 0, rows: [] };
    }
    if (/SELECT path, ad_state FROM ad_settings/.test(sql)) return { rows: [] };
    return handler ? handler(sql, params) : { rowCount: 0, rows: [] };
  };

  pool.query = mockQuery;
  pool.connect = async () => ({
    query: mockQuery,
    release: () => {}
  });
}

function restorePool() {
  if (originalQuery) { pool.query = originalQuery; originalQuery = null; }
  if (originalConnect) { pool.connect = originalConnect; originalConnect = null; }
}

const http = (p, opts) => fetch(`http://127.0.0.1:${port}${p}`, opts);

test('1. local deletion removes the user and all dependent records', async () => {
  installPoolStub();
  process.env.LOCAL_USER_DELETE_ENABLED = 'true';
  process.env.NODE_ENV = 'development';

  const res = await http('/admin/users/99/delete', {
    method: 'POST',
    headers: { 'Cookie': OWNER_COOKIE },
    redirect: 'manual'
  });
  
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/admin?msg=deleted');

  const expectedTables = [
    'folder_permissions', 'user_roles', 'user_product_grants', 
    'paid_product_events', 'promo_redemptions', 'premium_subscription_events', 
    'premium_subscriptions', 'paid_orders', 'paid_subscriptions', 
    'role_audit_log', 'user_sessions', 'users'
  ];

  let deleteCount = 0;
  for (const call of calls) {
    if (call.sql.includes('DELETE FROM')) {
      const tableMatch = expectedTables.find(t => call.sql.includes(t));
      if (tableMatch) deleteCount++;
    }
  }
  assert.ok(deleteCount >= expectedTables.length, 'Should execute deletes for all dependent tables');
  
  restorePool();
});

test('2. deletion is unavailable when the feature is disabled', async () => {
  installPoolStub();
  process.env.LOCAL_USER_DELETE_ENABLED = 'false';
  process.env.NODE_ENV = 'development';

  const res = await http('/admin/users/99/delete', {
    method: 'POST',
    headers: { 'Cookie': OWNER_COOKIE },
    redirect: 'manual'
  });
  
  assert.equal(res.status, 302);
  assert.ok(res.headers.get('location').includes('User%20deletion%20is%20only%20available%20in%20local%20development.'));
  restorePool();
});

test('3. production environment enables the feature when flag is true', async () => {
  installPoolStub();
  process.env.LOCAL_USER_DELETE_ENABLED = 'true';
  process.env.NODE_ENV = 'production';

  const res = await http('/admin/users/99/delete', {
    method: 'POST',
    headers: { 'Cookie': OWNER_COOKIE },
    redirect: 'manual'
  });

  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/admin?msg=deleted');
  restorePool();
});

test('3b. production environment disables the feature when flag is false', async () => {
  installPoolStub();
  process.env.LOCAL_USER_DELETE_ENABLED = 'false';
  process.env.NODE_ENV = 'production';

  const res = await http('/admin/users/99/delete', {
    method: 'POST',
    headers: { 'Cookie': OWNER_COOKIE },
    redirect: 'manual'
  });

  assert.equal(res.status, 302);
  assert.ok(res.headers.get('location').includes('User%20deletion%20is%20only%20available%20in%20local%20development.'));
  restorePool();
});

test('4. OWNER cannot be deleted', async () => {
  installPoolStub();
  process.env.LOCAL_USER_DELETE_ENABLED = 'true';
  process.env.NODE_ENV = 'development';

  const res = await http('/admin/users/10/delete', {
    method: 'POST',
    headers: { 'Cookie': ADMIN_COOKIE },
    redirect: 'manual'
  });
  
  assert.equal(res.status, 302);
  console.log('Location:', res.headers.get('location'));
  assert.ok(res.headers.get('location').includes('Cannot%20delete%20OWNER%20or%20ADMIN%20accounts.'));
  restorePool();
});

test('5. ADMIN cannot be deleted', async () => {
  installPoolStub();
  process.env.LOCAL_USER_DELETE_ENABLED = 'true';
  process.env.NODE_ENV = 'development';

  const res = await http('/admin/users/11/delete', {
    method: 'POST',
    headers: { 'Cookie': OWNER_COOKIE },
    redirect: 'manual'
  });
  
  assert.equal(res.status, 302);
  assert.ok(res.headers.get('location').includes('Cannot%20delete%20OWNER%20or%20ADMIN%20accounts.'));
  restorePool();
});

test('6. logged-in user cannot delete themselves', async () => {
  installPoolStub();
  process.env.LOCAL_USER_DELETE_ENABLED = 'true';
  process.env.NODE_ENV = 'development';

  const res = await http('/admin/users/99/delete', {
    method: 'POST',
    headers: { 'Cookie': USER_COOKIE },
    redirect: 'manual'
  });
  
  // User is not admin, so requireAdmin returns 403
  assert.equal(res.status, 403);
  restorePool();
});


test('6b. admin cannot delete their own account when flag is enabled', async () => {
  installPoolStub();
  process.env.LOCAL_USER_DELETE_ENABLED = 'true';
  process.env.NODE_ENV = 'production';

  const res = await http('/admin/users/11/delete', {
    method: 'POST',
    headers: { 'Cookie': ADMIN_COOKIE },
    redirect: 'manual'
  });

  assert.equal(res.status, 302);
  assert.ok(res.headers.get('location').includes('Cannot%20delete%20your%20own%20account.'));
  restorePool();
});

test('7. /admin page renders successfully when local deletion is enabled', async () => {
  installPoolStub();
  process.env.LOCAL_USER_DELETE_ENABLED = 'true';
  process.env.NODE_ENV = 'development';
  
  const originalAdminQuery = pool.query;
  const mockAll = async (sql, params = []) => {
    if (/SELECT[\s\S]*COUNT\([\s\S]*\)[\s\S]*FROM users/i.test(sql)) {
       return { rows: [{ total_users: 1, active_today: 1, active_month: 1, pending_users: 0, views_today: 0, copies_today: 0, total_discussions: 0, total_replies: 0 }] };
    }
    if (sql.includes('LEFT JOIN (') && sql.includes('premium_subscriptions')) {
       return { rows: [OWNER, USER] };
    }
    return originalAdminQuery(sql, params);
  };
  
  pool.query = mockAll;
  pool.connect = async () => ({ query: mockAll, release: () => {} });
  
  const res = await http('/admin', { headers: { 'Cookie': OWNER_COOKIE } });

  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('Delete User'));
  restorePool();
});

async function fetchAdminHtmlAsOwner() {
  const originalAdminQuery = pool.query;
  const mockAll = async (sql, params = []) => {
    if (/SELECT[\s\S]*COUNT\([\s\S]*\)[\s\S]*FROM users/i.test(sql)) {
       return { rows: [{ total_users: 3, active_today: 3, active_month: 3, pending_users: 0, views_today: 0, copies_today: 0, total_discussions: 0, total_replies: 0 }] };
    }
    if (sql.includes('LEFT JOIN (') && sql.includes('premium_subscriptions')) {
       return { rows: [OWNER, ADMIN, USER] };
    }
    return originalAdminQuery(sql, params);
  };

  pool.query = mockAll;
  pool.connect = async () => ({ query: mockAll, release: () => {} });

  const res = await http('/admin', { headers: { 'Cookie': OWNER_COOKIE } });
  assert.equal(res.status, 200);
  return res.text();
}

test('8. /admin shows Delete User in production when flag is true', async () => {
  installPoolStub();
  process.env.LOCAL_USER_DELETE_ENABLED = 'true';
  process.env.NODE_ENV = 'production';

  const html = await fetchAdminHtmlAsOwner();
  assert.ok(html.includes('Delete User'), 'Delete button visible in production with flag enabled');
  // Normal user row offers delete; own OWNER row and ADMIN row must not
  assert.ok(html.includes('/admin/users/99/delete'), 'normal user row has delete form');
  assert.ok(!html.includes('/admin/users/10/delete'), 'OWNER row has no delete form');
  assert.ok(!html.includes('/admin/users/11/delete'), 'ADMIN row has no delete form');
  assert.ok(html.includes("Are you sure you want to completely delete this user and all their records? This is irreversible."), 'confirmation dialog unchanged');
  restorePool();
});

test('9. /admin hides Delete User in production when flag is false', async () => {
  installPoolStub();
  process.env.LOCAL_USER_DELETE_ENABLED = 'false';
  process.env.NODE_ENV = 'production';

  const html = await fetchAdminHtmlAsOwner();
  assert.ok(!html.includes('Delete User'), 'Delete button hidden when flag disabled');
  restorePool();
});
