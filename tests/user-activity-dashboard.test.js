import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import cookieSignature from 'cookie-signature';
import { pool } from '../src/db/pool.js';

const { app } = await import('../src/server.js');

const ADMIN = {
  id: 100, google_user_id: 'google-admin', email: 'admin@example.com', name: 'Admin',
  status: 'active', first_login_at: new Date(), last_login_at: new Date(),
  access_expires_at: null, app_role: 'ADMIN'
};

const ADMIN_SID = 'activity-admin-sid';
const ADMIN_COOKIE = `connect.sid=s:${cookieSignature.sign(ADMIN_SID, process.env.SESSION_SECRET)}`;
const sessionToUser = { [ADMIN_SID]: ADMIN };

// Mock data fixtures for test suite
let fixtures = {
  users: [
    { id: 101, email: 'alice@example.com', name: 'Alice Smith', status: 'active', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: new Date(Date.now() + 10 * 86400000), app_role: 'USER', created_at: new Date() },
    { id: 102, email: 'bob@example.com', name: 'Bob Jones', status: 'pending', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: null, app_role: 'USER', created_at: new Date() },
  ],
  stats: { total_users: 2, active_today: 1, active_month: 2, pending_users: 1, views_today: 0, copies_today: 0, total_discussions: 0, total_replies: 0 },
  likes: [
    { user_id: 101, item_path: 'Guidewire/PolicyCenter.txt', created_at: new Date() }
  ],
  views: [
    { user_id: 101, item_path: 'Guidewire/BillingCenter.txt', last_viewed_at: new Date(), created_at: new Date() }
  ],
  seen: [
    { user_id: 101, item_path: 'Guidewire/ClaimCenter.txt', seen_at: new Date(), status: 'seen', created_at: new Date() },
    { user_id: 102, item_path: 'Guidewire/TestingCenter.txt', seen_at: new Date(), status: 'ignored', created_at: new Date() }
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
      if (params[0] === 100) return { rows: [ADMIN] };
      const u = fixtures.users.find(x => x.id === params[0]);
      return { rows: u ? [u] : [] };
    }
    if (/user_roles/.test(sql)) return { rows: [] };
    if (/folder_permissions/.test(sql)) return { rows: [{ folder_path: 'Guidewire', access_level: 'all', role_id: null }] };
    
    // Stats query
    if (/FROM users/.test(sql) && /COUNT\(\*\)::int AS total_users/.test(sql)) {
      return { rows: [fixtures.stats] };
    }
    // getUsersForAdmin
    if (/FROM users/.test(sql) && /ORDER BY created_at DESC/.test(sql)) {
      if (sql.includes('id IN')) {
        const filtered = fixtures.users.filter(u => params.includes(u.id));
        return { rows: filtered };
      }
      // Handle simple search mock
      if (sql.includes('ILIKE')) {
        const term = params[0].replace(/%/g, '').toLowerCase();
        const filtered = fixtures.users.filter(u => u.name.toLowerCase().includes(term) || u.email.toLowerCase().includes(term));
        return { rows: filtered };
      }
      // Handle status filter mock
      if (sql.includes("status = 'pending'")) {
        return { rows: fixtures.users.filter(u => u.status === 'pending') };
      }
      return { rows: fixtures.users };
    }
    // COUNT queries
    if (/SELECT COUNT\(\*\)::int AS count FROM users/i.test(sql)) {
      if (sql.includes('id IN')) {
        const count = fixtures.users.filter(u => params.includes(u.id)).length;
        return { rows: [{ count }] };
      }
      if (sql.includes('ILIKE')) {
        const term = params[0].replace(/%/g, '').toLowerCase();
        const count = fixtures.users.filter(u => u.name.toLowerCase().includes(term) || u.email.toLowerCase().includes(term)).length;
        return { rows: [{ count }] };
      }
      if (sql.includes("status = 'pending'")) {
        return { rows: [{ count: fixtures.users.filter(u => u.status === 'pending').length }] };
      }
      return { rows: [{ count: fixtures.users.length }] };
    }
    
    // likedItems
    if (/FROM item_likes/i.test(sql) && /array_agg/i.test(sql)) {
      return { rows: [{ item_path: 'Guidewire/PolicyCenter.txt', like_count: 1, likers: [{ name: 'Alice', email: 'alice@example.com', liked_at: new Date() }] }] };
    }
    // Batch activity queries
    if (/FROM item_likes/i.test(sql)) {
      return { rows: fixtures.likes };
    }
    if (/FROM recently_viewed/i.test(sql)) {
      return { rows: fixtures.views };
    }
    if (/FROM content_seen/i.test(sql)) {
      return { rows: fixtures.seen };
    }

    // Default fallbacks for standard endpoints
    if (/FROM query_usage/.test(sql)) return { rows: [] };
    if (/array_agg/.test(sql)) return { rows: [] };
    if (/access_audit_log/.test(sql)) return { rows: [] };
    if (/role_audit_log/.test(sql)) return { rows: [] };
    if (/content_permissions/.test(sql)) return { rows: [] };
    if (/unanswered_count/.test(sql)) {
      return { rows: [{ unanswered_count: 0, hidden_questions_count: 0, hidden_replies_count: 0, recent_questions_count: 0, recent_replies_count: 0 }] };
    }
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

test('User Activity & Learning Dashboard sections rendered', async () => {
  const res = await http('/admin/user-activity', { headers: { Cookie: ADMIN_COOKIE } });
  if (res.status !== 200) {
    console.error("DEBUG ERROR PAGE:", await res.text());
  }
  assert.equal(res.status, 200);
  const html = await res.text();

  assert.match(html, /User Activity & Learning/);
  assert.match(html, /data-testid="user-activity-card"/);
  assert.match(html, /Alice Smith/);
  assert.match(html, /Bob Jones/);
});

test('Search functionality works correctly in Dashboard', async () => {
  const res = await http('/admin/user-activity?activity_search=Alice', { headers: { Cookie: ADMIN_COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();
  
  const dashboardHtml = html.substring(html.indexOf('id="activity-dashboard"'));
  assert.match(dashboardHtml, /Alice Smith/);
  assert.doesNotMatch(dashboardHtml, /Bob Jones/);
});

test('Status filtering works correctly in Dashboard', async () => {
  const res = await http('/admin/user-activity?activity_status=pending', { headers: { Cookie: ADMIN_COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();

  const dashboardHtml = html.substring(html.indexOf('id="activity-dashboard"'));
  assert.match(dashboardHtml, /Bob Jones/);
  assert.doesNotMatch(dashboardHtml, /Alice Smith/);
});

test('Dashboard renders likes, views, and seen history with correct names and formats', async () => {
  const res = await http('/admin/user-activity', { headers: { Cookie: ADMIN_COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();

  assert.match(html, /PolicyCenter/);
  assert.match(html, /BillingCenter/);
  assert.match(html, /ClaimCenter/);
  assert.match(html, /TestingCenter/);
  assert.match(html, /dismissed/);
  assert.match(html, /seen/);
});

test('Multi-select dropdown filtering by user IDs displays selected user and hides others', async () => {
  // Query with Alice's ID (101)
  const res = await http('/admin/user-activity?activity_users=101', { headers: { Cookie: ADMIN_COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();

  const dashboardHtml = html.substring(html.indexOf('id="activity-dashboard"'));
  assert.match(dashboardHtml, /Alice Smith/);
  assert.doesNotMatch(dashboardHtml, /Bob Jones/);
});
