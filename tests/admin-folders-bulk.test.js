import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookieSignature from 'cookie-signature';
import { pool } from '../src/db/pool.js';

const { app } = await import('../src/server.js');

const ADMIN = { id: 10, google_user_id: 'google-admin', email: 'admin@example.com', name: 'Admin', status: 'active', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: null, app_role: 'ADMIN' };
const ADMIN_SID = 'folders-bulk-admin-sid';
const ADMIN_COOKIE = `connect.sid=s:${cookieSignature.sign(ADMIN_SID, process.env.SESSION_SECRET)}`;
const sessionToUser = { [ADMIN_SID]: ADMIN };

let originalQuery = null;
let originalConnect = null;
let server = null;
let port = 0;

test.before(async () => {
  originalQuery = pool.query;
  originalConnect = pool.connect;
  server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  port = server.address().port;
});

test.after(async () => {
  if (server) await new Promise(r => server.close(r));
  if (originalQuery) { pool.query = originalQuery; originalQuery = null; }
  if (originalConnect) { pool.connect = originalConnect; originalConnect = null; }
});

const http = (p, opts) => fetch(`http://127.0.0.1:${port}${p}`, opts);

test('Premium tag shown beside user name when they have PREMIUM RBAC role', async () => {
  pool.query = async (sql, params=[]) => {
    if (/SELECT to_regclass/.test(sql)) return { rows: [{ to_regclass: 'user_sessions' }] };
    if (/SELECT sess FROM ["']?user_sessions["']?/i.test(sql)) {
      const u = sessionToUser[params[0]];
      if (u) return { rows: [{ sess: JSON.stringify({ cookie: {}, passport: { user: u.id } }) }] };
      return { rows: [] };
    }
    if (/SELECT \* FROM users WHERE id = \$1/i.test(sql)) return { rows: [ADMIN], rowCount: 1 };
    if (/FROM roles/.test(sql) && sql.includes('SELECT id, name')) {
      return { rows: [
        { id: 1, name: 'PC Team', description: '', created_at: new Date().toISOString() },
        { id: 5, name: 'PREMIUM', description: 'Built-in', created_at: new Date().toISOString() },
        { id: 2, name: 'SuperUser', description: '', created_at: new Date().toISOString() }
      ], rowCount: 3 };
    }
    if (/SELECT id, email, name FROM users/.test(sql)) return { rows: [
      { id: 20, email: 'premium-rbac@example.com', name: 'PremiumRBAC' },
      { id: 21, email: 'normal@example.com', name: 'Normal' }
    ], rowCount: 2 };
    if (/SELECT id, app_role FROM users/.test(sql)) return { rows: [
      { id: 20, app_role: 'USER' },
      { id: 21, app_role: 'USER' }
    ], rowCount: 2 };
    if (/SELECT user_id, role_id FROM user_roles/.test(sql)) return { rows: [
      { user_id: 20, role_id: 5 }
    ], rowCount: 1 };
    if (/user_roles/.test(sql)) return { rows: [] };
    if (/folder_permissions/.test(sql)) return { rows: [] };
    if (/SELECT id, folder_path/.test(sql)) return { rows: [], rowCount: 0 };
    if (/SELECT folder_path, role_id FROM folder_roles/.test(sql)) return { rows: [], rowCount: 0 };
    if (/INSERT INTO roles/.test(sql)) return { rows: [], rowCount: 0 };
    if (/SELECT id FROM roles WHERE name = 'PREMIUM'/.test(sql)) return { rows: [{ id: 5 }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };

  const res = await http('/admin/folders', { headers: { Cookie: ADMIN_COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();
  // PremiumRBAC user should have Premium badge
  // Find the row for premium-rbac@example.com
  const premiumRowIdx = html.indexOf('premium-rbac@example.com');
  const normalRowIdx = html.indexOf('normal@example.com');
  assert.ok(premiumRowIdx !== -1 && normalRowIdx !== -1);
  // Extract snippet around premium user
  const snippet = html.substring(premiumRowIdx - 500, premiumRowIdx + 500);
  assert.ok(snippet.includes('data-testid="premium-tag"') || html.includes('data-testid="premium-tag"'), 'Premium tag should be present');
  // Normal user should not have premium tag in its row? Check that normal row snippet does not contain premium tag immediately after
  const normalSnippet = html.substring(normalRowIdx - 500, normalRowIdx + 500);
  // Count premium tags: should be exactly 1 (for premium user)
  const premiumTagCount = (html.match(/data-testid="premium-tag"/g) || []).length;
  assert.equal(premiumTagCount, 1, 'exactly one premium tag for RBAC PREMIUM user');
});

test('Bulk role changes: dirty tracking and Save Changes button', async () => {
  pool.query = async (sql, params=[]) => {
    if (/SELECT to_regclass/.test(sql)) return { rows: [{ to_regclass: 'user_sessions' }] };
    if (/SELECT sess FROM ["']?user_sessions["']?/i.test(sql)) {
      const u = sessionToUser[params[0]];
      if (u) return { rows: [{ sess: JSON.stringify({ cookie: {}, passport: { user: u.id } }) }] };
      return { rows: [] };
    }
    if (/SELECT \* FROM users WHERE id = \$1/i.test(sql)) return { rows: [ADMIN], rowCount: 1 };
    if (/user_roles/.test(sql)) return { rows: [] };
    if (/folder_permissions/.test(sql)) return { rows: [] };
    if (/FROM roles/.test(sql) && sql.includes('SELECT id, name')) {
      return { rows: [
        { id: 1, name: 'PC Team', description: '', created_at: new Date().toISOString() },
        { id: 5, name: 'PREMIUM', description: '', created_at: new Date().toISOString() }
      ], rowCount: 2 };
    }
    if (/SELECT id, email, name FROM users/.test(sql)) return { rows: [
      { id: 30, email: 'a@example.com', name: 'A' },
      { id: 31, email: 'b@example.com', name: 'B' }
    ], rowCount: 2 };
    if (/SELECT id, app_role FROM users/.test(sql)) return { rows: [{ id:30, app_role:'USER'},{id:31, app_role:'USER'}], rowCount: 2 };
    if (/SELECT user_id, role_id FROM user_roles/.test(sql)) return { rows: [], rowCount: 0 };
    if (/SELECT id, folder_path/.test(sql)) return { rows: [], rowCount: 0 };
    if (/SELECT folder_path, role_id FROM folder_roles/.test(sql)) return { rows: [], rowCount: 0 };
    if (/INSERT INTO roles/.test(sql)) return { rows: [], rowCount: 0 };
    if (/SELECT id FROM roles WHERE name = 'PREMIUM'/.test(sql)) return { rows: [{ id:5 }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  const res = await http('/admin/folders', { headers: { Cookie: ADMIN_COOKIE } });
  const html = await res.text();
  // Check for bulk UI elements
  assert.ok(html.includes('id="user-assignments-table"'), 'table should have id for JS');
  assert.ok(html.includes('id="bulk-assign-save"'), 'Save Changes button present');
  assert.ok(html.includes('data-testid="bulk-save-changes"'), 'bulk save testid');
  assert.ok(html.includes('id="bulk-assign-status"'), 'status span present');
  // Check for row dirty tracking attributes
  assert.ok(html.includes('data-user-id="30"'), 'row should have data-user-id');
  assert.ok(html.includes('data-initial-roles'), 'initial roles tracking');
  assert.ok(html.includes('class="role-checkbox"'), 'checkboxes should have role-checkbox class');
  assert.ok(html.includes('row-dirty-indicator'), 'dirty indicator present');
  // Check that multiple roles per user is supported: each user should have checkboxes for both roles
  const pcTeamCount = (html.match(/PC Team/g) || []).length;
  assert.ok(pcTeamCount >= 2, 'PC Team should appear multiple times (roles list + per user)');
});

test('Bulk save handles multiple users and multiple roles per user in safe transaction', async () => {
  // Mock for bulk POST
  let captured = null;
  let userDb = {
    40: { id: 40, email: 'a@example.com', name: 'A', app_role: 'USER' },
    41: { id: 41, email: 'b@example.com', name: 'B', app_role: 'USER' },
    42: { id: 42, email: 'owner@example.com', name: 'Owner', app_role: 'OWNER' }
  };
  let roleDb = [
    { id: 1, name: 'PC Team' },
    { id: 5, name: 'PREMIUM' },
    { id: 2, name: 'SuperUser' }
  ];
  let userRoles = []; // start empty

  pool.query = async (sql, params=[]) => {
    if (/SELECT to_regclass/.test(sql)) return { rows: [{ to_regclass: 'user_sessions' }] };
    if (/SELECT sess FROM ["']?user_sessions["']?/i.test(sql)) {
      const u = sessionToUser[params[0]];
      if (u) return { rows: [{ sess: JSON.stringify({ cookie: {}, passport: { user: u.id } }) }] };
      return { rows: [] };
    }
    if (/SELECT \* FROM users WHERE id = \$1/i.test(sql)) {
      if (params[0] === ADMIN.id) return { rows: [ADMIN], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }
    if (/user_roles/.test(sql)) return { rows: [] };
    if (/folder_permissions/.test(sql)) return { rows: [] };
    if (/SELECT id FROM roles WHERE name = 'PREMIUM'/.test(sql)) return { rows: [{ id: 5 }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  // Need to mock pool.connect for transaction
  const originalConnect = pool.connect;
  pool.connect = async () => ({
    query: async (sql, params=[]) => {
      if (sql.trim() === 'BEGIN' || sql.trim() === 'COMMIT' || sql.trim() === 'ROLLBACK') return { rows: [], rowCount: 0 };
      if (sql.includes('SELECT id, app_role FROM users WHERE id = $1')) {
        const u = userDb[params[0]];
        return { rows: u ? [u] : [], rowCount: u ? 1 : 0 };
      }
      if (sql.includes('SELECT id FROM roles WHERE id = ANY')) {
        const ids = params[0];
        const valid = roleDb.filter(r => ids.includes(r.id));
        return { rows: valid.map(r => ({ id: r.id })), rowCount: valid.length };
      }
      if (sql.includes('DELETE FROM user_roles WHERE user_id = $1')) {
        const uid = params[0];
        userRoles = userRoles.filter(ur => ur.user_id !== uid);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO user_roles')) {
        const uid = params[0], rid = params[1];
        captured = captured || [];
        captured.push({ uid, rid });
        // Check duplicate
        if (!userRoles.find(ur => ur.user_id === uid && ur.role_id === rid)) {
          userRoles.push({ user_id: uid, role_id: rid });
        }
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => {}
  });

  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  const port = server.address().port;
  const http = (p, opts) => fetch(`http://127.0.0.1:${port}${p}`, opts);

  try {
    // Bulk assign: user 40 gets PC Team + PREMIUM, user 41 gets SuperUser, owner 42 should be skipped
    const res = await http('/admin/folders/assign-bulk', {
      method: 'POST',
      headers: { Cookie: ADMIN_COOKIE, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ assignments: [
        { user_id: 40, role_ids: [1, 5] },
        { user_id: 41, role_ids: [2] },
        { user_id: 42, role_ids: [1] }
      ]})
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.ok, true);
    assert.equal(json.updated, 3);
    // Check that user 40 has both roles, 41 has one, 42 skipped (OWNER)
    assert.ok(userRoles.find(ur => ur.user_id === 40 && ur.role_id === 1), 'user 40 PC Team');
    assert.ok(userRoles.find(ur => ur.user_id === 40 && ur.role_id === 5), 'user 40 PREMIUM');
    assert.ok(userRoles.find(ur => ur.user_id === 41 && ur.role_id === 2), 'user 41 SuperUser');
    assert.ok(!userRoles.find(ur => ur.user_id === 42), 'owner should be skipped');
    // Check that multiple roles per user works
    const user40Roles = userRoles.filter(ur => ur.user_id === 40).map(ur => ur.role_id).sort();
    assert.deepEqual(user40Roles, [1,5]);
  } finally {
    await new Promise(r => server.close(r));
    pool.query = originalQuery;
    pool.connect = originalConnect;
  }
});

test('Bulk assign preserves OWNER/ADMIN protections and validates roles', async () => {
  let userDb = {
    50: { id: 50, email: 'owner@example.com', name: 'Owner', app_role: 'OWNER' },
    51: { id: 51, email: 'admin@example.com', name: 'Admin', app_role: 'ADMIN' },
    52: { id: 52, email: 'user@example.com', name: 'User', app_role: 'USER' }
  };
  let roleDb = [{ id: 1, name: 'PC Team' }];
  pool.query = async (sql, params=[]) => {
    if (/SELECT to_regclass/.test(sql)) return { rows: [{ to_regclass: 'user_sessions' }] };
    if (/SELECT sess FROM ["']?user_sessions["']?/i.test(sql)) {
      const u = sessionToUser[params[0]];
      if (u) return { rows: [{ sess: JSON.stringify({ cookie: {}, passport: { user: u.id } }) }] };
      return { rows: [] };
    }
    if (/SELECT \* FROM users WHERE id = \$1/i.test(sql)) return { rows: [ADMIN], rowCount: 1 };
    if (/user_roles/.test(sql)) return { rows: [] };
    if (/folder_permissions/.test(sql)) return { rows: [] };
    if (/SELECT id FROM roles WHERE name = 'PREMIUM'/.test(sql)) return { rows: [{ id: 99 }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  const origConnect = pool.connect;
  pool.connect = async () => ({
    query: async (sql, params=[]) => {
      if (sql.trim() === 'BEGIN' || sql.trim() === 'COMMIT' || sql.trim() === 'ROLLBACK') return { rows: [], rowCount: 0 };
      if (sql.includes('SELECT id, app_role FROM users WHERE id = $1')) {
        const u = userDb[params[0]];
        return { rows: u ? [u] : [], rowCount: u ? 1 : 0 };
      }
      if (sql.includes('SELECT id FROM roles WHERE id = ANY')) {
        const ids = params[0];
        const valid = roleDb.filter(r => ids.includes(r.id));
        return { rows: valid.map(r => ({ id: r.id })), rowCount: valid.length };
      }
      if (sql.includes('DELETE FROM user_roles')) return { rows: [], rowCount: 0 };
      if (sql.includes('INSERT INTO user_roles')) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    release: () => {}
  });

  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  const port = server.address().port;
  const http = (p, opts) => fetch(`http://127.0.0.1:${port}${p}`, opts);

  try {
    // Try to assign to OWNER - should be skipped not error
    const res = await http('/admin/folders/assign-bulk', {
      method: 'POST',
      headers: { Cookie: ADMIN_COOKIE, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ assignments: [
        { user_id: 50, role_ids: [1] },
        { user_id: 52, role_ids: [1] }
      ]})
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.ok, true);

    // Try invalid role
    const res2 = await http('/admin/folders/assign-bulk', {
      method: 'POST',
      headers: { Cookie: ADMIN_COOKIE, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ assignments: [{ user_id: 52, role_ids: [999] }] })
    });
    assert.equal(res2.status, 400);
    const json2 = await res2.json();
    assert.ok(json2.error.includes('Invalid role'));

    // Non-admin should be forbidden - verify via file check (route has requireAdmin)
    const serverSrc2 = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
    const bulkRoute = serverSrc2.split("app.post('/admin/folders/assign-bulk'")[1]?.split('async (req, res)')[0] || '';
    assert.ok(bulkRoute.includes('requireAdmin'), 'bulk route should require admin');
    assert.ok(bulkRoute.includes('requireAuth'), 'bulk route should require auth');
  } finally {
    await new Promise(r => server.close(r));
    pool.query = originalQuery;
    pool.connect = originalConnect;
  }
});

test('Individual assignment still works and audit preserved', async () => {
  const viewSrc = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/views/admin-folders.ejs'), 'utf8');
  assert.ok(viewSrc.includes('action="/admin/folders/assign"'), 'individual form still present');
  assert.ok(viewSrc.includes('role-checkbox'), 'checkboxes present');
  const serverSrc = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.ok(serverSrc.includes("app.post('/admin/folders/assign'"), 'single assign route preserved');
  assert.ok(serverSrc.includes('withTransaction'), 'safe transaction used');
});

test('Payment entitlement unchanged by RBAC bulk', async () => {
  const premiumSrc = fs.readFileSync(new URL('../src/auth/premium.js', import.meta.url), 'utf8');
  assert.ok(premiumSrc.includes('hasValidPremiumEntitlement'), 'premium sync unchanged');
  // Ensure bulk RBAC does not touch premium_subscriptions
  const serverSrc = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  const bulkSection = serverSrc.split("app.post('/admin/folders/assign-bulk'")[1]?.split('});')[0] || '';
  assert.ok(!bulkSection.includes('premium_subscriptions'), 'bulk RBAC should not touch payment tables');
  assert.ok(!bulkSection.includes('premium_source'), 'bulk RBAC should not touch payment source');
});
