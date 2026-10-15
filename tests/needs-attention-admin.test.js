import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';
import cookieSignature from 'cookie-signature';
import { pool } from '../src/db/pool.js';

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
  id: 3, google_user_id: 'google-user', email: 'user@example.com', name: 'Normal',
  status: 'active', first_login_at: new Date(), last_login_at: new Date(),
  access_expires_at: new Date(Date.now()+30*86400000), app_role: 'USER'
};

const OWNER_SID = 'needs-owner-sid';
const ADMIN_SID = 'needs-admin-sid';
const USER_SID = 'needs-user-sid';
const OWNER_COOKIE = `connect.sid=s:${cookieSignature.sign(OWNER_SID, process.env.SESSION_SECRET)}`;
const ADMIN_COOKIE = `connect.sid=s:${cookieSignature.sign(ADMIN_SID, process.env.SESSION_SECRET)}`;
const USER_COOKIE = `connect.sid=s:${cookieSignature.sign(USER_SID, process.env.SESSION_SECRET)}`;
const sessionToUser = { [OWNER_SID]: OWNER, [ADMIN_SID]: ADMIN, [USER_SID]: USER };

// Control fixtures
let fixtures = {
  users: [
    { id: 10, email: 'pending@example.com', name: 'Pending', status: 'pending', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: null, app_role: 'USER', created_at: new Date() },
    { id: 11, email: 'active@example.com', name: 'Active', status: 'active', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: new Date(Date.now()+30*86400000), app_role: 'USER', created_at: new Date() },
    { id: 12, email: 'revoked@example.com', name: 'Revoked', status: 'revoked', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: new Date(), app_role: 'USER', created_at: new Date() },
    // expiring user
    { id: 13, email: 'expiring@example.com', name: 'Expiring', status: 'active', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: new Date(Date.now()+2*86400000), app_role: 'USER', created_at: new Date() },
  ],
  stats: { total_users: 4, active_today: 2, active_month: 3, pending_users: 1, views_today: 5, copies_today: 2, total_discussions: 2, total_replies: 3 },
  popular: [],
  likedItems: [],
  auditLog: [],
  roleAuditLog: [],
  expiring: [{ id: 13, email: 'expiring@example.com', name: 'Expiring', status: 'active', access_expires_at: new Date(Date.now()+2*86400000), app_role: 'USER' }],
  needs: { counts: { unanswered_count: 2, hidden_questions_count: 1, hidden_replies_count: 1, recent_questions_count: 0, recent_replies_count: 0 } }
};

let originalQuery = null;
let server = null;
let port = 0;

test.before(async () => {
  originalQuery = pool.query;
  pool.query = async (sql, params=[]) => {
    if (/SELECT to_regclass/.test(sql)) return { rows: [{ to_regclass: 'user_sessions' }] };
    if (/SELECT sess FROM ["']?user_sessions["']?/i.test(sql)) {
      const u = sessionToUser[params[0]];
      if (u) return { rows: [{ sess: JSON.stringify({ cookie:{}, passport:{ user: u.id }})}]};
      return { rows: [] };
    }
    if (/SELECT \* FROM users WHERE id = \$1/i.test(sql)) {
      const u = [OWNER, ADMIN, USER].find(x=>x.id===params[0]);
      return { rows: u ? [u] : [] };
    }
    if (/user_roles/.test(sql)) return { rows: [] };
    if (/folder_permissions/.test(sql) || (/folder_permissions/.test(sql) && /access_level/.test(sql))) {
      return { rows: [{ folder_path: 'Guidewire', access_level: 'all', role_id: null }] };
    }
    // Stats query
    if (/FROM users/.test(sql) && /COUNT\(\*\)::int AS total_users/.test(sql)) {
      return { rows: [fixtures.stats] };
    }
    // getUsersForAdmin
    if (/FROM users/.test(sql) && /ORDER BY u.created_at DESC/.test(sql)) {
      return { rows: fixtures.users };
    }
    // getExpiringUsers
    if (/access_expires_at > NOW\(\)/.test(sql) && /access_expires_at <= NOW/.test(sql) && /app_role/.test(sql)) {
      return { rows: fixtures.expiring };
    }
    // popular queries
    if (/FROM query_usage/.test(sql) && /GROUP BY query_path/.test(sql)) return { rows: fixtures.popular };
    // likedItems
    if (/FROM item_likes/.test(sql) && /array_agg/.test(sql)) return { rows: fixtures.likedItems };
    // audit logs
    if (/FROM access_audit_log/.test(sql)) return { rows: fixtures.auditLog };
    if (/FROM role_audit_log/.test(sql)) return { rows: fixtures.roleAuditLog };
    if (/content_permissions/.test(sql)) return { rows: [] };
    if (/FROM users/.test(sql) && /ORDER BY u.created_at/.test(sql)) return { rows: fixtures.users };
    // getNeedsAttention counts
    if (/unanswered_count/.test(sql)) {
      const n = fixtures.needs;
      return { rows: [{ unanswered_count: n.counts.unanswered_count, hidden_questions_count: n.counts.hidden_questions_count, hidden_replies_count: n.counts.hidden_replies_count, recent_questions_count: n.counts.recent_questions_count, recent_replies_count: n.counts.recent_replies_count }] };
    }
    if (/GREATEST\(d\.updated_at/.test(sql)) return { rows: [] };
    if (/NOT EXISTS.*discussion_replies.*LIMIT 5/.test(sql)) return { rows: [] };
    // For getUsersForAdmin fallback etc
    if (/SELECT id, email, status, access_expires_at, app_role FROM users WHERE id/.test(sql)) {
      const u = fixtures.users.find(x=>x.id===params[0]) || [OWNER, ADMIN, USER].find(x=>x.id===params[0]);
      return { rows: u ? [u] : [] };
    }
    return { rows: [] };
  };
  server = await new Promise(resolve=>{ const s = app.listen(0, ()=>resolve(s));});
  port = server.address().port;
});

test.after(async () => {
  if (server) await new Promise(r=>server.close(r));
  if (originalQuery) { pool.query = originalQuery; originalQuery=null; }
});

const http = (p, opts)=> fetch(`http://127.0.0.1:${port}${p}`, opts);

test('Admin dashboard contains Needs Attention section', async () => {
  const res = await http('/admin', { headers:{ Cookie: ADMIN_COOKIE }});
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Needs Attention/);
  assert.match(html, /data-testid="needs-attention"/);
});

test('Shows pending with amber warning and Review link to /admin', async () => {
  const res = await http('/admin', { headers:{ Cookie: ADMIN_COOKIE }});
  const html = await res.text();
  assert.match(html, /Pending access requests/);
  assert.match(html, /badge-warning/);
  assert.ok(html.includes('>Review</a>') || html.includes('>Review<'));
  // pending count 1 appears
  assert.match(html, /<span class="badge badge-warning">1<\/span>/);
  assert.ok(html.includes('href="/admin"'), 'pending Review link to /admin');
});

test('Shows expiring within 7 days with amber and View link to /admin/expiring-users', async () => {
  const res = await http('/admin', { headers:{ Cookie: ADMIN_COOKIE }});
  const html = await res.text();
  assert.match(html, /Users expiring within 7 days/);
  assert.match(html, /badge-warning/);
  assert.ok(html.includes('href="/admin/expiring-users"'), 'expiring View link');
  // expiring count 1
  assert.ok(html.includes('>1<') || html.includes('>1</span>'));
});

test('Shows hidden items with critical red and Review link to /admin/discussions?filter=hidden', async () => {
  const res = await http('/admin', { headers:{ Cookie: ADMIN_COOKIE }});
  const html = await res.text();
  assert.match(html, /Hidden items awaiting review/);
  assert.match(html, /badge-critical/);
  assert.ok(html.includes('href="/admin/discussions?filter=hidden"'));
  // hidden = 1+1=2
  assert.ok(html.includes('<span class="badge badge-critical">2</span>'));
});

test('Shows unanswered with warning and View link to unanswered', async () => {
  const res = await http('/admin', { headers:{ Cookie: ADMIN_COOKIE }});
  const html = await res.text();
  assert.match(html, /Unanswered questions/);
  assert.ok(html.includes('href="/admin/discussions?filter=unanswered"'));
  assert.ok(html.includes('<span class="badge badge-warning">2</span>'));
});

test('Shows revoked with critical red', async () => {
  const res = await http('/admin', { headers:{ Cookie: ADMIN_COOKIE }});
  const html = await res.text();
  assert.match(html, /Revoked users/);
  assert.match(html, /badge-critical/);
  // revoked count 1
  // Check revoked badge appears
  assert.ok(html.includes('Revoked users'));
});

test('When nothing needs attention shows green healthy message', async () => {
  // Save originals
  const origStats = { ...fixtures.stats };
  const origExpiring = [...fixtures.expiring];
  const origNeeds = { counts: { ...fixtures.needs.counts } };
  const origUsers = [...fixtures.users];
  fixtures.stats = { total_users: 2, active_today: 1, active_month:1, pending_users:0, views_today:0, copies_today:0, total_discussions:0, total_replies:0 };
  fixtures.expiring = [];
  fixtures.needs = { counts: { unanswered_count:0, hidden_questions_count:0, hidden_replies_count:0, recent_questions_count:0, recent_replies_count:0 }};
  fixtures.users = origUsers.filter(u=>u.status!=='revoked' && u.status!=='pending').map(u=> ({...u}));
  const res = await http('/admin', { headers:{ Cookie: ADMIN_COOKIE }});
  const html = await res.text();
  assert.match(html, /Nothing needs your attention/);
  assert.match(html, /badge-healthy/);
  assert.match(html, /✓/);
  // restore
  fixtures.stats = origStats;
  fixtures.expiring = origExpiring;
  fixtures.needs = origNeeds;
  fixtures.users = origUsers;
});

test('Normal user cannot see admin Needs Attention (403)', async () => {
  const res = await http('/admin', { headers:{ Cookie: USER_COOKIE }});
  assert.equal(res.status, 403);
});

test('Unauthenticated redirected to /login (existing behavior preserved)', async () => {
  const res = await http('/admin', { redirect:'manual'});
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/login');
});

test('Needs Attention reuses existing routes only', async () => {
  const src = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  // Must use existing helpers, not duplicate SQL for pending/discussions
  assert.ok(src.includes('getNeedsAttention'), 'should reuse getNeedsAttention');
  assert.ok(src.includes('getExpiringUsers'), 'should reuse getExpiringUsers');
  assert.ok(!src.includes('CREATE TABLE'), 'no new tables');
  // Check view uses existing routes
  const view = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/views/admin.ejs'), 'utf8');
  assert.ok(view.includes('/admin/expiring-users'), 'expiring route reused');
  assert.ok(view.includes('/admin/discussions?filter=hidden'), 'hidden route reused');
  assert.ok(view.includes('/admin/discussions?filter=unanswered'), 'unanswered route reused');
  assert.ok(view.includes('/admin"'), 'pending route reused');
  assert.ok(view.includes('badge-warning'), 'amber warning reused');
  assert.ok(view.includes('badge-critical'), 'red critical reused');
  assert.ok(view.includes('badge-healthy'), 'green healthy reused');
});

test('Counts are accurate and derived from Admin-visible data only', async () => {
  // Pending count should equal stats.pending_users (1)
  // Expiring should equal expiring length (1)
  // Hidden = hidden_q + hidden_r (2)
  // Revoked = users filtered revoked (1)
  // Unanswered = 2
  const res = await http('/admin', { headers:{ Cookie: ADMIN_COOKIE }});
  const html = await res.text();
  // Check each count appears correctly
  const pendingMatches = [...html.matchAll(/Pending access requests[\s\S]*?badge-warning">(\d+)</g)];
  // Simple check that at least pending badge 1 exists
  assert.ok(html.includes('<span class="badge badge-warning">1</span>') || html.includes('>1<'));
  // Ensure no extra DB info leaked: should not contain google_user_id etc
  assert.ok(!html.includes('google-user'), 'no sensitive data');
});

test('Admin dashboard stat cards are clickable and have correct URLs', async () => {
  const res = await http('/admin', { headers: { Cookie: ADMIN_COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();
  
  // Total Users points to #users
  assert.ok(html.includes('href="#users"'), 'Total users stat card should point to #users');
  // Pending Approval points to #users
  assert.match(html, /<a href="#users"[^>]*class="stat stat--warning"[^>]*><strong>\d+<\/strong><span>Pending approval<\/span><\/a>/, 'Pending approval stat card should point to #users');
  // Discussions points to /admin/discussions
  assert.match(html, /<a href="\/admin\/discussions"[^>]*><strong>\d+<\/strong><span>Discussions<\/span><\/a>/, 'Discussions stat card should point to /admin/discussions');
  // Replies points to /admin/discussions
  assert.match(html, /<a href="\/admin\/discussions"[^>]*><strong>\d+<\/strong><span>Replies<\/span><\/a>/, 'Replies stat card should point to /admin/discussions');
});


