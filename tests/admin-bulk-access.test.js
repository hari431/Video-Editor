import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import cookieSignature from 'cookie-signature';
import { readFile } from 'node:fs/promises';
import { pool } from '../src/db/pool.js';
import * as users from '../src/auth/users.js';

let originalQuery = null;
let originalConnect = null;

function installPoolStub(handler) {
  originalQuery = pool.query;
  pool.query = async (sql, params) => handler(sql, params);
}
function restorePool() {
  if (originalQuery) { pool.query = originalQuery; originalQuery = null; }
  if (originalConnect) { pool.connect = originalConnect; originalConnect = null; }
}

function row(overrides = {}) {
  return {
    id: 1,
    google_user_id: 'google-1',
    email: 'user@example.com',
    name: 'User',
    status: 'active',
    first_login_at: new Date(),
    last_login_at: new Date(),
    access_expires_at: new Date(Date.now() + 30 * 86400000),
    app_role: 'USER',
    ...overrides
  };
}

// Mock client for transactions
function mockClient(rowsById, calls) {
  return {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/BEGIN|COMMIT|ROLLBACK/.test(sql)) return { rowCount: 0, rows: [] };
      if (/SELECT.*FROM users WHERE id/.test(sql)) {
        const id = params[0];
        const r = rowsById[id];
        if (!r) return { rowCount: 0, rows: [] };
        return { rowCount: 1, rows: [r] };
      }
      if (/UPDATE users SET status = 'active'/.test(sql)) {
        const id = params[0];
        const expiry = params[1];
        const prev = rowsById[id];
        const updated = { ...prev, status: 'active', access_expires_at: expiry ? new Date(expiry) : prev.access_expires_at };
        return { rowCount: 1, rows: [updated] };
      }
      if (/UPDATE users SET status = 'revoked'/.test(sql)) {
        const id = params[0];
        const prev = rowsById[id];
        const updated = { ...prev, status: 'revoked', access_expires_at: new Date() };
        return { rowCount: 1, rows: [updated] };
      }
      if (/INSERT INTO access_audit_log/.test(sql)) return { rowCount: 1, rows: [] };
      return { rowCount: 0, rows: [] };
    },
    release: () => {}
  };
}

// Helper to setup app fetch tests
async function fetchAdminPage(queryString, allUsersRows) {
  const { app } = await import('../src/server.js');
  const ADMIN = { id: 99, google_user_id: 'google-admin', email: 'admin@example.com', name: 'Admin', status: 'active', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: null, app_role: 'ADMIN' };
  const ADMIN_SID = 'bulk-test-sid';
  const ADMIN_COOKIE = `connect.sid=s:${cookieSignature.sign(ADMIN_SID, process.env.SESSION_SECRET)}`;
  const sessionToUser = { [ADMIN_SID]: ADMIN };
  const originalQ = pool.query;
  pool.query = async (sql, params = []) => {
    if (/SELECT to_regclass/.test(sql)) return { rows: [{ to_regclass: 'user_sessions' }] };
    if (/SELECT sess FROM ["']?user_sessions["']?/i.test(sql)) {
      const u = sessionToUser[params[0]];
      if (u) return { rows: [{ sess: JSON.stringify({ cookie: {}, passport: { user: u.id } }) }] };
      return { rows: [] };
    }
    if (/SELECT \* FROM users WHERE id = \$1/i.test(sql)) return { rows: [ADMIN] };
    if (/user_roles/.test(sql)) return { rows: [] };
    if (/folder_permissions/.test(sql)) return { rows: [] };
    if (/FROM users/.test(sql) && /COUNT\(\*\)::int AS total_users/.test(sql)) {
      return { rows: [{ total_users: allUsersRows.length, active_today: 1, active_month: 1, pending_users: 1, views_today: 0, copies_today: 0, total_discussions: 0, total_replies: 0 }] };
    }
    if (/FROM users u/.test(sql) && /LEFT JOIN/.test(sql) && /ORDER BY u.created_at DESC/.test(sql)) {
      return { rows: allUsersRows };
    }
    if (/FROM users/.test(sql) && /SELECT id, email/.test(sql)) return { rows: allUsersRows.map(r=>({id:r.id,email:r.email,name:r.name})) };
    return { rows: [] };
  };
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const res = await fetch(`http://localhost:${port}/admin${queryString}`, { headers: { Cookie: ADMIN_COOKIE } });
    const html = await res.text();
    return { status: res.status, html, restore: () => { server.close(); pool.query = originalQ; } };
  } catch (e) {
    server.close(); pool.query = originalQ; throw e;
  }
}

test.afterEach(() => {
  restorePool();
  delete process.env.ADMIN_EMAILS;
});

// 1. Status filter
test('status filter: All/Pending/Active/Expired/Revoked filtering', async () => {
  const now = Date.now();
  const allRows = [
    { id: 1, google_user_id: 'g1', email: 'pending@example.com', name: 'Pending', status: 'pending', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: null, app_role: 'USER', created_at: new Date() },
    { id: 2, google_user_id: 'g2', email: 'active@example.com', name: 'Active', status: 'active', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: new Date(now + 10*86400000), app_role: 'USER', created_at: new Date() },
    { id: 3, google_user_id: 'g3', email: 'expired@example.com', name: 'Expired', status: 'active', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: new Date(now - 86400000), app_role: 'USER', created_at: new Date() },
    { id: 4, google_user_id: 'g4', email: 'revoked@example.com', name: 'Revoked', status: 'revoked', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: new Date(now - 1000), app_role: 'USER', created_at: new Date() },
  ];
  let r = await fetchAdminPage('?status=pending', allRows);
  assert.equal(r.status, 200);
  assert.ok(r.html.includes('pending@example.com'), 'pending filter shows pending');
  assert.ok(!r.html.includes('active@example.com'), 'pending filter hides active');
  assert.ok(r.html.includes('data-testid="status-filter"'), 'filter bar present');
  assert.ok(r.html.includes('data-testid="filter-pending"'), 'filter options present');
  r.restore();

  r = await fetchAdminPage('?status=active', allRows);
  assert.ok(r.html.includes('active@example.com'), 'active filter shows active');
  assert.ok(!r.html.includes('pending@example.com'), 'active hides pending');
  assert.ok(!r.html.includes('expired@example.com'), 'active hides expired (expired is not active)');
  r.restore();

  r = await fetchAdminPage('?status=expired', allRows);
  assert.ok(r.html.includes('expired@example.com'), 'expired filter shows expired');
  assert.ok(!r.html.includes('active@example.com'));
  r.restore();

  r = await fetchAdminPage('?status=revoked', allRows);
  assert.ok(r.html.includes('revoked@example.com'));
  r.restore();

  r = await fetchAdminPage('', allRows);
  assert.ok(r.html.includes('pending@example.com') && r.html.includes('active@example.com') && r.html.includes('expired@example.com') && r.html.includes('revoked@example.com'), 'all shows all');
  r.restore();

  r = await fetchAdminPage('?status=all', allRows);
  assert.ok(r.html.includes('pending@example.com') && r.html.includes('revoked@example.com'));
  r.restore();
});

// 1b. Status filter UX: anchor to Users section
test('status filter UX: links preserve scroll to Users section via #users anchor', async () => {
  const rows = [
    { id: 1, google_user_id: 'g1', email: 'user@example.com', name: 'User', status: 'pending', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: null, app_role: 'USER', created_at: new Date() },
  ];
  const r = await fetchAdminPage('', rows);
  const html = r.html;
  // All filter links must include #users fragment
  for (const f of ['all','pending','active','expired','revoked']) {
    assert.ok(html.includes(`/admin?status=${f}#users`), `filter ${f} link should contain #users anchor`);
    assert.ok(html.includes(`data-testid="filter-${f}"`), `filter ${f} testid present`);
  }
  // Users heading provides target
  assert.ok(html.includes('<h2 id="users">'), 'Users heading has id="users" anchor target');
  // Ensure filter preserves selection: active filter should have badge-active
  const r2 = await fetchAdminPage('?status=pending', rows);
  assert.ok(r2.html.includes('data-testid="filter-pending"'), 'pending filter present after navigation');
  // Check that link still has anchor even when already filtered
  assert.ok(r2.html.includes(`/admin?status=pending#users`), 'filtered page still has anchor');
  r.restore();
  r2.restore();
  // Source file directly contains anchor logic
  const adminSrc = await readFile(new URL('../src/views/admin.ejs', import.meta.url), 'utf8');
  assert.ok(adminSrc.includes('#users'), 'admin.ejs filter links include #users');
  // No backend filtering logic changed is verified by previous test; ensure backend still uses statusDisplay
  const serverSrc = await readFile(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.ok(serverSrc.includes('currentStatusFilter'), 'backend filter preserved');
});

// 2. Checkbox + Select All
test('checkbox to every eligible row plus Select All and bulk bar', async () => {
  const rows = [
    { id: 10, google_user_id: 'g10', email: 'user10@example.com', name: 'U10', status: 'pending', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: null, app_role: 'USER', created_at: new Date() },
    { id: 11, google_user_id: 'g11', email: 'owner@example.com', name: 'Owner', status: 'active', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: null, app_role: 'OWNER', created_at: new Date() },
  ];
  const r = await fetchAdminPage('', rows);
  assert.ok(r.html.includes('data-testid="select-all"'), 'Select All checkbox present');
  assert.ok(r.html.includes('data-testid="bulk-actions"'), 'bulk bar present');
  assert.ok(r.html.includes('data-testid="selected-count"'), 'selected count present');
  assert.ok(r.html.includes('data-testid="bulk-expiry"'), 'date picker present');
  assert.ok(r.html.includes('data-testid="bulk-activate"'), 'bulk activate present');
  assert.ok(r.html.includes('data-testid="bulk-extend"'), 'bulk extend present');
  assert.ok(r.html.includes('data-testid="bulk-revoke"'), 'bulk revoke present');
  // eligible row has checkbox, owner protected has no checkbox (shows —)
  assert.ok(r.html.includes('value="10"'), 'eligible user has checkbox with value');
  assert.ok(!r.html.includes('value="11"'), 'owner should not have checkbox value 11');
  // User checkboxes class
  assert.ok(r.html.includes('class="user-checkbox"'), 'user-checkbox class present');
  // Confirmation is via JS confirm; verify script contains confirm strings
  const adminSrc = await readFile(new URL('../src/views/admin.ejs', import.meta.url), 'utf8');
  assert.ok(adminSrc.includes('confirm('), 'confirmation required');
  assert.ok(adminSrc.includes('selected-count'), 'selected count logic');
  r.restore();
});

// 3. Per-user actions must respect status
test('per-user actions respect status: Pending->Activate, Active->Extend/Revoke, Expired->Activate, Revoked->Activate', async () => {
  const now = Date.now();
  const rows = [
    { id: 1, google_user_id: 'g1', email: 'pending@example.com', name: 'Pending', status: 'pending', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: null, app_role: 'USER', created_at: new Date() },
    { id: 2, google_user_id: 'g2', email: 'active@example.com', name: 'Active', status: 'active', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: new Date(now + 10*86400000), app_role: 'USER', created_at: new Date() },
    { id: 3, google_user_id: 'g3', email: 'expired@example.com', name: 'Expired', status: 'active', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: new Date(now - 86400000), app_role: 'USER', created_at: new Date() },
    { id: 4, google_user_id: 'g4', email: 'revoked@example.com', name: 'Revoked', status: 'revoked', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: new Date(now - 1000), app_role: 'USER', created_at: new Date() },
  ];
  const r = await fetchAdminPage('', rows);
  const html = r.html;

  // Pending: should have Activate (approve) button, not Extend/Revoke
  assert.ok(html.includes('/admin/users/1/approve'), 'pending has approve/activate action');
  // Check that pending row contains Activate text
  assert.ok(html.includes('Activate'), 'Activate label present');
  // Active: should have extend and revoke, not approve
  assert.ok(html.includes('/admin/users/2/extend'), 'active has extend');
  assert.ok(html.includes('/admin/users/2/revoke'), 'active has revoke');
  // Expired: should have reactivate (Activate) but NOT extend or revoke
  assert.ok(html.includes('/admin/users/3/reactivate'), 'expired has reactivate/activate');
  // Ensure expired row does NOT have extend or revoke form for that user id
  const expiredSection = html.split('expired@example.com')[1]?.split('revoked@example.com')[0] || '';
  assert.ok(expiredSection.includes('/admin/users/3/reactivate'), 'expired section has reactivate');
  assert.ok(!expiredSection.includes('/admin/users/3/extend'), 'expired should not have extend');
  assert.ok(!expiredSection.includes('/admin/users/3/revoke'), 'expired should not have revoke');

  // Revoked: should have reactivate, not extend/revoke
  assert.ok(html.includes('/admin/users/4/reactivate'), 'revoked has reactivate');

  r.restore();
});

// 5. Date handling: exact date, not additive
test('Activate and Extend use exact Access Until date, not additive', async () => {
  const future = new Date(Date.now() + 20*86400000);
  const futureISO = future.toISOString().slice(0,10);
  // Test bulkActivate sets exact date
  const rows = {
    1: row({ id: 1, status: 'pending', access_expires_at: null }),
    2: row({ id: 2, status: 'active', access_expires_at: new Date(Date.now() - 1000) }), // expired
    3: row({ id: 3, status: 'revoked', access_expires_at: new Date() }),
  };
  const calls = [];
  const client = mockClient(rows, calls);
  originalConnect = pool.connect;
  pool.connect = async () => client;
  const expiry = new Date(`${futureISO}T23:59:59.999Z`);
  const result = await users.bulkActivateUsers(99, [1,2,3], expiry);
  assert.equal(result.applied, 3);
  // Verify that UPDATE used $2::timestamptz with exact expiry, not INTERVAL addition
  const updateCalls = calls.filter(c => /UPDATE users SET status = 'active'/.test(c.sql));
  for (const c of updateCalls) {
    assert.ok(c.sql.includes('$2::timestamptz'), 'must use exact date param');
    assert.ok(!/INTERVAL/.test(c.sql), 'must NOT add duration separately');
    assert.equal(c.params[1].getTime(), expiry.getTime(), 'exact date must match selected date');
  }
  restorePool();

  // Test bulk extend exact date
  const activeRows = {
    5: row({ id: 5, status: 'active', access_expires_at: new Date(Date.now() + 5*86400000) }),
  };
  const calls2 = [];
  const client2 = mockClient(activeRows, calls2);
  pool.connect = async () => client2;
  const result2 = await users.bulkExtendUsersSafe(99, [5], expiry);
  assert.equal(result2.applied, 1);
  const upd2 = calls2.find(c => /UPDATE users SET status = 'active'/.test(c.sql));
  assert.ok(upd2.sql.includes('$2::timestamptz'));
  assert.ok(!/INTERVAL/.test(upd2.sql));
  restorePool();
});

// 7. Revoke does not require date
test('Revoke does not require date', async () => {
  const rows = {
    5: row({ id: 5, status: 'active', access_expires_at: new Date(Date.now() + 5*86400000) }),
    6: row({ id: 6, status: 'pending', access_expires_at: null }),
  };
  const calls = [];
  const client = mockClient(rows, calls);
  pool.connect = async () => client;
  const result = await users.bulkRevokeUsers(99, [5,6]);
  assert.equal(result.applied, 1, 'only active should be applied');
  assert.equal(result.skipped, 1, 'pending skipped');
  const revokeCalls = calls.filter(c=>/UPDATE users SET status = 'revoked'/.test(c.sql));
  assert.equal(revokeCalls.length, 1);
  assert.equal(revokeCalls[0].params.length, 1, 'revoke uses only id, no date');
  restorePool();
});

// 8. Handle mixed selections safely
test('mixed selections: report applied/skipped/failed and do not apply invalid', async () => {
  const now = Date.now();
  const rows = {
    1: row({ id: 1, status: 'pending', access_expires_at: null }),
    2: row({ id: 2, status: 'active', access_expires_at: new Date(now + 10*86400000) }),
    3: row({ id: 3, status: 'active', access_expires_at: new Date(now - 86400000) }), // expired
    4: row({ id: 4, status: 'revoked', access_expires_at: new Date(now - 1000) }),
    5: { id: 5, email: 'admin@example.com', status: 'active', access_expires_at: null, app_role: 'ADMIN' }, // protected
  };
  let calls = [];
  let client = mockClient(rows, calls);
  pool.connect = async () => client;
  const expiry = new Date(now + 30*86400000);
  // Activate should apply to pending, expired, revoked but skip active and admin
  let res = await users.bulkActivateUsers(99, [1,2,3,4,5], expiry);
  assert.equal(res.applied, 3, 'activate applied 3 (1,3,4)');
  assert.equal(res.skipped, 2, 'activate skipped 2 (active, admin)');
  assert.equal(res.failed, 0);
  restorePool();

  calls = [];
  client = mockClient(rows, calls);
  pool.connect = async () => client;
  res = await users.bulkExtendUsersSafe(99, [1,2,3,4,5], expiry);
  assert.equal(res.applied, 1, 'extend only active');
  assert.equal(res.skipped, 4);
  restorePool();

  calls = [];
  client = mockClient(rows, calls);
  pool.connect = async () => client;
  res = await users.bulkRevokeUsers(99, [1,2,3,4,5]);
  assert.equal(res.applied, 1, 'revoke only active');
  assert.equal(res.skipped, 4);
  restorePool();
});

// 9. Preserve OWNER/ADMIN protection and audit logging
test('OWNER/ADMIN protection: bulk skips protected and logs audit for applied', async () => {
  process.env.ADMIN_EMAILS = 'admin@example.com';
  const rows = {
    1: { id: 1, email: 'admin@example.com', status: 'active', access_expires_at: new Date(Date.now() + 5*86400000), app_role: 'ADMIN' },
    2: row({ id: 2, status: 'pending', access_expires_at: null }),
  };
  const calls = [];
  const client = mockClient(rows, calls);
  pool.connect = async () => client;
  const expiry = new Date(Date.now() + 10*86400000);
  const result = await users.bulkActivateUsers(99, [1,2], expiry);
  assert.equal(result.applied, 1);
  assert.equal(result.skipped, 1, 'admin skipped');
  // audit log inserted only for applied user
  const auditCalls = calls.filter(c=>/INSERT INTO access_audit_log/.test(c.sql));
  assert.equal(auditCalls.length, 1, 'audit logged for applied only');
  assert.equal(auditCalls[0].params[0], 2, 'audit for user 2');
  assert.ok(auditCalls[0].params[2] === 'approve' || auditCalls[0].params[2] === 'reactivate' || auditCalls[0].params[2] === 'activate', 'audit action appropriate');
  restorePool();
  delete process.env.ADMIN_EMAILS;
});

// 10. Use parameterized SQL and safe transaction
test('bulk uses parameterized SQL and safe transaction', async () => {
  const rows = {
    1: row({ id: 1, status: 'pending', access_expires_at: null }),
  };
  const calls = [];
  const client = mockClient(rows, calls);
  pool.connect = async () => client;
  const expiry = new Date(Date.now() + 10*86400000);
  await users.bulkActivateUsers(99, [1], expiry);
  const sqls = calls.map(c=>c.sql);
  assert.ok(sqls.some(s=>s.includes('BEGIN')), 'transaction BEGIN');
  assert.ok(sqls.some(s=>s.includes('COMMIT')), 'transaction COMMIT');
  // Ensure parameterized: no string interpolation of user ids
  const update = calls.find(c=>/UPDATE users SET/.test(c.sql));
  assert.ok(update.sql.includes('$1') && update.sql.includes('$2'), 'parameterized SQL');
  // Ensure no direct interpolation of email or status
  assert.ok(!update.sql.includes('user@example.com'), 'no interpolated values');
  restorePool();
});

// Authorization: bulk endpoints require admin
test('authorization: non-admin cannot use bulk endpoints', async () => {
  const { app } = await import('../src/server.js');
  const USER = { id: 50, google_user_id: 'g-user', email: 'user@example.com', name: 'User', status: 'active', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: new Date(Date.now()+ 30*86400000), app_role: 'USER' };
  const USER_SID = 'user-sid-bulk';
  const USER_COOKIE = `connect.sid=s:${cookieSignature.sign(USER_SID, process.env.SESSION_SECRET)}`;
  const sessionToUser = { [USER_SID]: USER };
  const orig = pool.query;
  pool.query = async (sql, params = []) => {
    if (/SELECT to_regclass/.test(sql)) return { rows: [{ to_regclass: 'user_sessions' }] };
    if (/SELECT sess FROM ["']?user_sessions["']?/i.test(sql)) {
      const u = sessionToUser[params[0]];
      if (u) return { rows: [{ sess: JSON.stringify({ cookie: {}, passport: { user: u.id } }) }] };
      return { rows: [] };
    }
    if (/SELECT \* FROM users WHERE id/.test(sql)) return { rows: [USER] };
    if (/user_roles/.test(sql)) return { rows: [] };
    if (/folder_permissions/.test(sql)) return { rows: [] };
    return { rows: [] };
  };
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const future = new Date(Date.now()+ 10*86400000).toISOString().slice(0,10);
    for (const path of ['/admin/users/bulk-activate', '/admin/users/bulk-extend', '/admin/users/bulk-revoke', '/admin/users/bulk']) {
      const res = await fetch(`http://localhost:${port}${path}`, {
        method: 'POST',
        headers: { Cookie: USER_COOKIE, 'Content-Type': 'application/json' },
        body: JSON.stringify({ userIds: [1], expiry: future, action: 'activate' })
      });
      assert.equal(res.status, 403, `${path} should be 403 for non-admin`);
    }
  } finally {
    server.close();
    pool.query = orig;
  }
});

// Preserve single-user behavior and DEFAULT_ACCESS_DAYS
test('preserve single-user behavior and DEFAULT_ACCESS_DAYS', async () => {
  const serverSrc = await readFile(new URL('../src/server.js', import.meta.url), 'utf8');
  // Single-user routes still exist
  assert.ok(serverSrc.includes("app.post('/admin/users/:id/approve'"), 'approve route preserved');
  assert.ok(serverSrc.includes("app.post('/admin/users/:id/extend'"), 'extend route preserved');
  assert.ok(serverSrc.includes("app.post('/admin/users/:id/revoke'"), 'revoke route preserved');
  assert.ok(serverSrc.includes("app.post('/admin/users/:id/reactivate'"), 'reactivate route preserved');
  assert.ok(serverSrc.includes('DEFAULT_ACCESS_DAYS'), 'DEFAULT_ACCESS_DAYS preserved');
  assert.ok(serverSrc.includes('PREMIUM'), 'Premium logic preserved');
  // Bulk functions still call logAccessChange / audit
  const usersSrc = await readFile(new URL('../src/auth/users.js', import.meta.url), 'utf8');
  assert.ok(usersSrc.includes('access_audit_log'), 'audit logging preserved');
  assert.ok(usersSrc.includes('isAdminUser'), 'OWNER/ADMIN protection preserved');
});

// Bulk navigation: redirects return to #users with preserved msg/filter
test('bulk actions navigation: redirects to #users with preserved filter and msg', async () => {
  const { app } = await import('../src/server.js');
  const ADMIN = { id: 99, google_user_id: 'google-admin', email: 'admin@example.com', name: 'Admin', status: 'active', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: null, app_role: 'ADMIN' };
  const ADMIN_SID = 'bulk-nav-sid';
  const ADMIN_COOKIE = `connect.sid=s:${cookieSignature.sign(ADMIN_SID, process.env.SESSION_SECRET)}`;
  const sessionToUser = { [ADMIN_SID]: ADMIN };
  const rows = {
    1: row({ id: 1, status: 'pending', access_expires_at: null }),
    2: row({ id: 2, status: 'active', access_expires_at: new Date(Date.now()+10*86400000) }),
  };
  const calls = [];
  const client = mockClient(rows, calls);
  const origQ = pool.query;
  const origC = pool.connect;
  pool.connect = async () => client;
  pool.query = async (sql, params=[]) => {
    if (/SELECT to_regclass/.test(sql)) return { rows: [{ to_regclass: 'user_sessions' }] };
    if (/SELECT sess FROM/.test(sql)) {
      const u = sessionToUser[params[0]];
      if (u) return { rows: [{ sess: JSON.stringify({ cookie: {}, passport: { user: u.id } }) }] };
      return { rows: [] };
    }
    if (/SELECT \* FROM users WHERE id/.test(sql)) return { rows: [ADMIN] };
    if (/user_roles/.test(sql)) return { rows: [] };
    if (/folder_permissions/.test(sql)) return { rows: [] };
    return { rows: [] };
  };
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const future = new Date(Date.now()+ 20*86400000).toISOString().slice(0,10);
    // bulk-activate without status -> should redirect to /admin?...#users
    let res = await fetch(`http://localhost:${port}/admin/users/bulk-activate`, {
      method: 'POST',
      headers: { Cookie: ADMIN_COOKIE, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ userIds: '1', expiry: future }).toString(),
      redirect: 'manual'
    });
    assert.equal(res.status, 302);
    let loc = res.headers.get('location');
    assert.ok(loc.includes('#users'), `bulk-activate redirect should contain #users, got ${loc}`);
    assert.ok(loc.includes('msg='), 'msg preserved');
    // bulk with status filter preserved
    res = await fetch(`http://localhost:${port}/admin/users/bulk-revoke`, {
      method: 'POST',
      headers: { Cookie: ADMIN_COOKIE, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ userIds: '2', status: 'active' }).toString(),
      redirect: 'manual'
    });
    assert.equal(res.status, 302);
    loc = res.headers.get('location');
    assert.ok(loc.includes('#users'), `bulk-revoke with filter should contain #users, got ${loc}`);
    assert.ok(loc.includes('status=active'), `filter preserved, got ${loc}`);
    assert.ok(loc.includes('msg='), 'msg preserved with filter');
    // error case also has #users
    res = await fetch(`http://localhost:${port}/admin/users/bulk-activate`, {
      method: 'POST',
      headers: { Cookie: ADMIN_COOKIE, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ userIds: '', expiry: future }).toString(),
      redirect: 'manual'
    });
    assert.equal(res.status, 302);
    loc = res.headers.get('location');
    assert.ok(loc.includes('#users'), `error redirect should also contain #users, got ${loc}`);
    assert.ok(loc.includes('error='), 'error preserved');
    // generic bulk
    res = await fetch(`http://localhost:${port}/admin/users/bulk`, {
      method: 'POST',
      headers: { Cookie: ADMIN_COOKIE, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ action: 'revoke', userIds: '2', status: 'revoked' }).toString(),
      redirect: 'manual'
    });
    assert.equal(res.status, 302);
    loc = res.headers.get('location');
    assert.ok(loc.includes('#users'));
    assert.ok(loc.includes('status=revoked'));
    // verify bulk forms include hidden status input for current filter
    const adminSrc = await readFile(new URL('../src/views/admin.ejs', import.meta.url), 'utf8');
    assert.ok(adminSrc.includes('name="status" value="<%= _filter %>"'), 'bulk forms should preserve filter via hidden status');
  } finally {
    server.close();
    pool.query = origQ;
    pool.connect = origC;
  }
});

// Bulk date JSON API returns counts
test('bulk API via JSON returns applied/skipped/failed counts', async () => {
  const { app } = await import('../src/server.js');
  const ADMIN = { id: 99, google_user_id: 'google-admin', email: 'admin@example.com', name: 'Admin', status: 'active', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: null, app_role: 'ADMIN' };
  const ADMIN_SID = 'bulk-json-sid';
  const ADMIN_COOKIE = `connect.sid=s:${cookieSignature.sign(ADMIN_SID, process.env.SESSION_SECRET)}`;
  const sessionToUser = { [ADMIN_SID]: ADMIN };
  const rows = {
    1: row({ id: 1, status: 'pending', access_expires_at: null }),
    2: row({ id: 2, status: 'active', access_expires_at: new Date(Date.now()+10*86400000) }),
  };
  const calls = [];
  const client = mockClient(rows, calls);
  const origQ = pool.query;
  const origC = pool.connect;
  pool.connect = async () => client;
  pool.query = async (sql, params=[]) => {
    if (/SELECT to_regclass/.test(sql)) return { rows: [{ to_regclass: 'user_sessions' }] };
    if (/SELECT sess FROM/.test(sql)) {
      const u = sessionToUser[params[0]];
      if (u) return { rows: [{ sess: JSON.stringify({ cookie: {}, passport: { user: u.id } }) }] };
      return { rows: [] };
    }
    if (/SELECT \* FROM users WHERE id/.test(sql)) return { rows: [ADMIN] };
    if (/user_roles/.test(sql)) return { rows: [] };
    if (/folder_permissions/.test(sql)) return { rows: [] };
    return { rows: [] };
  };
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const future = new Date(Date.now()+ 20*86400000).toISOString().slice(0,10);
    const res = await fetch(`http://localhost:${port}/admin/users/bulk-activate`, {
      method: 'POST',
      headers: { Cookie: ADMIN_COOKIE, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ userIds: [1,2], expiry: future })
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.applied, 1, 'pending applied, active skipped');
    assert.equal(body.skipped, 1);
  } finally {
    server.close();
    pool.query = origQ;
    pool.connect = origC;
  }
});
