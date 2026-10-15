import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookieSignature from 'cookie-signature';
import { pool } from '../src/db/pool.js';

const { app } = await import('../src/server.js');

const ADMIN = {
  id: 100, google_user_id: 'google-admin', email: 'admin@example.com', name: 'Admin',
  status: 'active', first_login_at: new Date(), last_login_at: new Date(),
  access_expires_at: null, app_role: 'ADMIN'
};
const OWNER = {
  id: 101, google_user_id: 'google-owner', email: 'owner@example.com', name: 'Owner',
  status: 'active', first_login_at: new Date(), last_login_at: new Date(),
  access_expires_at: null, app_role: 'OWNER'
};
const USER = {
  id: 102, google_user_id: 'google-user', email: 'user@example.com', name: 'Normal',
  status: 'active', first_login_at: new Date(), last_login_at: new Date(),
  access_expires_at: new Date(Date.now()+30*86400000), app_role: 'USER'
};

const ADMIN_SID = 'audit-admin-sid';
const OWNER_SID = 'audit-owner-sid';
const USER_SID = 'audit-user-sid';
const ADMIN_COOKIE = `connect.sid=s:${cookieSignature.sign(ADMIN_SID, process.env.SESSION_SECRET)}`;
const OWNER_COOKIE = `connect.sid=s:${cookieSignature.sign(OWNER_SID, process.env.SESSION_SECRET)}`;
const USER_COOKIE = `connect.sid=s:${cookieSignature.sign(USER_SID, process.env.SESSION_SECRET)}`;
const sessionToUser = { [ADMIN_SID]: ADMIN, [OWNER_SID]: OWNER, [USER_SID]: USER };

let fixtures = {
  users: [
    { id: 1, email: 'alice@example.com', name: 'Alice', status: 'active', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: new Date(Date.now()+10*86400000), app_role: 'USER', created_at: new Date() },
  ],
  stats: { total_users: 1, active_today: 1, active_month: 1, pending_users: 0, views_today: 0, copies_today: 0, total_discussions: 0, total_replies: 0 },
  auditLog: [
    { id: 1, action: 'approve', previous_status: 'pending', new_status: 'active', previous_expires_at: null, new_expires_at: new Date('2024-02-01T00:00:00Z'), created_at: new Date('2024-02-01T10:00:00Z'), user_email: 'alice@example.com', admin_email: 'admin@example.com' }
  ],
  roleAuditLog: [
    { id: 1, action: 'grant_admin', previous_role: 'USER', new_role: 'ADMIN', created_at: new Date('2024-02-02T10:00:00Z'), target_email: 'bob@example.com', target_name: 'Bob', actor_email: 'owner@example.com', actor_name: 'Owner' }
  ],
  contentAuditLog: [
    { id: 1, permission: 'COPY_QUERY', action: 'GRANT', created_at: new Date('2024-02-03T10:00:00Z'), target_email: 'alice@example.com', target_name: 'Alice', actor_email: 'owner@example.com', actor_name: 'Owner' }
  ]
};

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
      const all = [ADMIN, OWNER, USER];
      const found = all.find(x => x.id === params[0]);
      return { rows: found ? [found] : [] };
    }
    if (/user_roles/.test(sql)) return { rows: [] };
    if (/folder_permissions/.test(sql)) return { rows: [{ folder_path: 'Guidewire', access_level: 'all', role_id: null }] };
    if (/FROM users/.test(sql) && /COUNT\(\*\)::int AS total_users/.test(sql)) {
      return { rows: [fixtures.stats] };
    }
    if (/FROM access_audit_log/.test(sql)) return { rows: fixtures.auditLog };
    if (/FROM role_audit_log/.test(sql)) return { rows: fixtures.roleAuditLog };
    if (/FROM content_permission_audit_log/.test(sql)) return { rows: fixtures.contentAuditLog };
    if (/content_action_permissions/.test(sql) || /content_permissions/.test(sql)) return { rows: [] };
    if (/FROM users/.test(sql) && /ORDER BY u.created_at DESC/.test(sql)) return { rows: fixtures.users };
    if (/FROM users/.test(sql) && /ORDER BY created_at DESC/.test(sql)) return { rows: fixtures.users };
    if (/unanswered_count/.test(sql)) return { rows: [{ unanswered_count: 0, hidden_questions_count: 0, hidden_replies_count: 0, recent_questions_count: 0, recent_replies_count: 0 }] };
    if (/SELECT id, email, status, access_expires_at, app_role FROM users WHERE id/.test(sql)) {
      const all = [ADMIN, OWNER, USER, ...fixtures.users];
      const found = all.find(x => x.id === params[0]);
      return { rows: found ? [found] : [] };
    }
    // fallback for popular/liked queries (previous organization)
    if (/FROM query_usage/.test(sql) && /GROUP BY query_path/.test(sql)) return { rows: [] };
    if (/FROM item_likes/.test(sql) && /array_agg/.test(sql)) return { rows: [] };
    if (/FROM item_likes/.test(sql)) return { rows: [] };
    if (/FROM recently_viewed/.test(sql)) return { rows: [] };
    if (/FROM content_seen/.test(sql)) return { rows: [] };
    if (/SELECT COUNT\(\*\)::int AS count FROM users/i.test(sql)) return { rows: [{ count: 1 }] };
    if (/SELECT id, google_user_id, email, name, status/.test(sql)) return { rows: fixtures.users };
    return { rows: [] };
  };
  server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  port = server.address().port;
});

test.after(async () => {
  if (server) await new Promise(r => server.close(r));
  if (originalQuery) { pool.query = originalQuery; originalQuery = null; }
});

const http = (p, opts) => fetch(`http://127.0.0.1:${port}${p}`, opts);

test('Admin overview no longer contains audit log sections after migration', async () => {
  const res = await http('/admin', { headers: { Cookie: ADMIN_COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(!html.includes('Access audit log'), 'admin should not contain Access audit log after migration');
  assert.ok(!html.includes('Role audit log'), 'admin should not contain Role audit log after migration');
  // The Content Permissions management table should still be present for Owner, but its audit log table should be gone
  // Since we logged in as ADMIN (not owner), Content Permissions section itself is hidden; still audit header should not appear
  assert.ok(!html.includes('Content permission audit log'), 'admin should not contain Content permission audit log after migration');
  // Ensure users table still present
  assert.match(html, /Users/);
});

test('Audit Logs page requires admin auth - normal user gets 403', async () => {
  const res = await http('/admin/audit-logs', { headers: { Cookie: USER_COOKIE } });
  assert.equal(res.status, 403);
});

test('Audit Logs page redirects unauthenticated to /login', async () => {
  const res = await http('/admin/audit-logs', { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/login');
});

test('Admin can access Audit Logs page and sees tabs', async () => {
  const res = await http('/admin/audit-logs', { headers: { Cookie: ADMIN_COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Audit Logs/);
  assert.match(html, /data-testid="audit-tabs"/);
  assert.ok(html.includes('data-testid="tab-all"'), 'All Logs tab');
  assert.ok(html.includes('data-testid="tab-access"'), 'Access tab');
  assert.ok(html.includes('data-testid="tab-role"'), 'Role tab');
  assert.ok(html.includes('data-testid="tab-content"'), 'Content Permission tab');
  assert.ok(html.includes('href="/admin/audit-logs?filter=all"'));
  assert.ok(html.includes('href="/admin/audit-logs?filter=access"'));
  assert.ok(html.includes('href="/admin/audit-logs?filter=role"'));
  assert.ok(html.includes('href="/admin/audit-logs?filter=content"'));
});

test('Audit Logs All filter shows all three audit tables with details', async () => {
  const res = await http('/admin/audit-logs?filter=all', { headers: { Cookie: ADMIN_COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();
  // All three tables present
  assert.ok(html.includes('data-testid="access-audit-table"'), 'access table present for all');
  assert.ok(html.includes('data-testid="role-audit-table"'), 'role table present for all');
  assert.ok(html.includes('data-testid="content-audit-table"'), 'content table present for all');
  // Verify audit details preserved
  assert.ok(html.includes('alice@example.com'), 'access target email preserved');
  assert.ok(html.includes('approve'), 'access action preserved');
  assert.ok(html.includes('badge-pending'), 'status badge styling preserved');
  assert.ok(html.includes('bob@example.com'), 'role target preserved');
  assert.ok(html.includes('grant_admin'), 'role action preserved');
  assert.ok(html.includes('badge-owner') || html.includes('badge-admin') || html.includes('badge-neutral'), 'role badge preserved');
  assert.ok(html.includes('COPY_QUERY'), 'content permission preserved');
  assert.ok(html.includes('GRANT'), 'content action preserved');
  // Styling preserved
  assert.ok(html.includes('class="admin-table"'), 'admin-table styling preserved');
});

test('Audit Logs filter=access shows only Access, not Role/Content', async () => {
  const res = await http('/admin/audit-logs?filter=access', { headers: { Cookie: ADMIN_COOKIE } });
  const html = await res.text();
  assert.ok(html.includes('data-testid="access-audit-table"'), 'access table visible');
  assert.ok(!html.includes('data-testid="role-audit-table"'), 'role table hidden for access filter');
  assert.ok(!html.includes('data-testid="content-audit-table"'), 'content table hidden for access filter');
  assert.ok(html.includes('Access audit log'));
});

test('Audit Logs filter=role shows only Role', async () => {
  const res = await http('/admin/audit-logs?filter=role', { headers: { Cookie: ADMIN_COOKIE } });
  const html = await res.text();
  assert.ok(!html.includes('data-testid="access-audit-table"'));
  assert.ok(html.includes('data-testid="role-audit-table"'));
  assert.ok(!html.includes('data-testid="content-audit-table"'));
  assert.ok(html.includes('Role audit log'));
});

test('Audit Logs filter=content shows only Content Permission', async () => {
  const res = await http('/admin/audit-logs?filter=content', { headers: { Cookie: ADMIN_COOKIE } });
  const html = await res.text();
  assert.ok(!html.includes('data-testid="access-audit-table"'));
  assert.ok(!html.includes('data-testid="role-audit-table"'));
  assert.ok(html.includes('data-testid="content-audit-table"'));
  assert.ok(html.includes('Content permission audit log'));
});

test('Owner can also access Audit Logs', async () => {
  const res = await http('/admin/audit-logs', { headers: { Cookie: OWNER_COOKIE } });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Audit Logs/);
});

test('Admin navigation contains Audit Logs link', async () => {
  const adminRes = await http('/admin', { headers: { Cookie: ADMIN_COOKIE } });
  const adminHtml = await adminRes.text();
  assert.ok(adminHtml.includes('href="/admin/audit-logs"'), 'admin nav should contain Audit Logs link');
  assert.ok(adminHtml.includes('>Audit Logs<'), 'link text present');

  const auditRes = await http('/admin/audit-logs', { headers: { Cookie: ADMIN_COOKIE } });
  const auditHtml = await auditRes.text();
  assert.ok(auditHtml.includes('href="/admin"'), 'audit page nav should contain Admin link');
  assert.ok(auditHtml.includes('Audit Logs'), 'audit page should indicate current location');
  // Check other admin pages also have the link (user-activity)
  const uaRes = await http('/admin/user-activity', { headers: { Cookie: ADMIN_COOKIE } });
  const uaHtml = await uaRes.text();
  assert.ok(uaHtml.includes('href="/admin/audit-logs"'), 'user-activity nav should contain Audit Logs');
});

test('Server reuses existing audit data logic without duplication', async () => {
  const src = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  const viewSrc = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/views/admin-audit-logs.ejs'), 'utf8');
  const adminView = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/views/admin.ejs'), 'utf8');
  // New route exists and uses existing helpers
  assert.ok(src.includes("app.get('/admin/audit-logs'"), 'audit-logs route exists');
  assert.ok(src.includes('requireAuth') && src.includes('requireAdmin'), 'audit route protected');
  assert.ok(src.includes('getAuditLog'), 'reuses getAuditLog');
  assert.ok(src.includes('getRoleAuditLog'), 'reuses getRoleAuditLog');
  assert.ok(src.includes('getContentPermissionAuditLog'), 'reuses getContentPermissionAuditLog');
  // Main admin route should no longer fetch/pass audit logs
  const adminRouteSnippet = src.split("app.get('/admin',")[1]?.split("app.get('/admin/premium'")[0] || '';
  assert.ok(!adminRouteSnippet.includes('getAuditLog'), 'admin route should not fetch auditLog after migration');
  assert.ok(!adminRouteSnippet.includes('getRoleAuditLog'), 'admin route should not fetch role audit after migration');
  assert.ok(!adminRouteSnippet.includes('getContentPermissionAuditLog'), 'admin route should not fetch content audit after migration');
  assert.ok(!adminRouteSnippet.includes('auditLog'), 'admin render should not contain auditLog param');
  // View reuses rendering logic
  assert.ok(viewSrc.includes('access_audit_log') || viewSrc.includes('Access audit log'), 'audit view renders access log');
  assert.ok(viewSrc.includes('Role audit log'));
  assert.ok(viewSrc.includes('Content permission audit log'));
  assert.ok(viewSrc.includes('statusBadge'), 'reuses statusBadge helper');
  assert.ok(viewSrc.includes('roleBadge'), 'reuses roleBadge helper');
  assert.ok(!adminView.includes('Access audit log'), 'admin.ejs no longer contains Access audit log');
  assert.ok(!adminView.includes('Role audit log'), 'admin.ejs no longer contains Role audit log');
  assert.ok(!adminView.includes('Content permission audit log'), 'admin.ejs no longer contains Content permission audit log');
});

test('Audit details preserved - timestamps, actions, target info', async () => {
  const res = await http('/admin/audit-logs?filter=all', { headers: { Cookie: ADMIN_COOKIE } });
  const html = await res.text();
  // Access log columns: When, User, Action, Status change, Expiry change, Admin
  assert.ok(html.includes('<th>When</th>'), 'When column preserved');
  assert.ok(html.includes('<th>User</th>'), 'User column preserved');
  assert.ok(html.includes('<th>Action</th>'), 'Action column preserved');
  assert.ok(html.includes('<th>Status change</th>'), 'Status change preserved');
  assert.ok(html.includes('<th>Expiry change</th>'), 'Expiry change preserved');
  assert.ok(html.includes('<th>Admin</th>'), 'Admin column preserved');
  // Role log columns
  assert.ok(html.includes('<th>Target</th>'), 'Target preserved');
  assert.ok(html.includes('<th>From</th>'), 'From preserved');
  assert.ok(html.includes('<th>To</th>'), 'To preserved');
  assert.ok(html.includes('<th>Actor</th>'), 'Actor preserved');
  // Content permission columns
  assert.ok(html.includes('<th>Permission</th>'), 'Permission preserved');
  // Timestamps rendered
  assert.ok(html.includes('2024'), 'timestamps preserved');
});
